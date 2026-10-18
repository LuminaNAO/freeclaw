import { CDP_JSON_NEW_TIMEOUT_MS } from "./cdp-timeouts.js";
import { fetchJson, fetchOk, normalizeCdpHttpBaseForJsonEndpoints } from "./cdp.helpers.js";
import { appendCdpPath, createTargetViaCdp, normalizeCdpWsUrl } from "./cdp.js";
import { listChromeMcpTabs, openChromeMcpTab } from "./chrome-mcp.js";
import type { ResolvedBrowserProfile } from "./config.js";
import {
  assertBrowserNavigationAllowed,
  assertBrowserNavigationResultAllowed,
  InvalidBrowserNavigationUrlError,
  requiresInspectableBrowserNavigationRedirects,
  withBrowserNavigationPolicy,
} from "./navigation-guard.js";
import { getBrowserProfileCapabilities } from "./profile-capabilities.js";
import type { PwAiModule } from "./pw-ai-module.js";
import { getPwAiModule } from "./pw-ai-module.js";
import {
  OPEN_TAB_DISCOVERY_POLL_MS,
  OPEN_TAB_DISCOVERY_WINDOW_MS,
} from "./server-context.constants.js";
import type {
  BrowserServerState,
  BrowserTab,
  OpenTabOptions,
  ProfileRuntimeState,
} from "./server-context.types.js";
import { isTabInUse, pruneTabMeta, selectTabsToEvict } from "./tab-hygiene.js";

type TabOpsDeps = {
  profile: ResolvedBrowserProfile;
  state: () => BrowserServerState;
  getProfileState: () => ProfileRuntimeState;
};

type ProfileTabOps = {
  listTabs: () => Promise<BrowserTab[]>;
  openTab: (url: string, opts?: OpenTabOptions) => Promise<BrowserTab>;
};

/**
 * Normalize a CDP WebSocket URL to use the correct base URL.
 */
function normalizeWsUrl(raw: string | undefined, cdpBaseUrl: string): string | undefined {
  if (!raw) {
    return undefined;
  }
  try {
    return normalizeCdpWsUrl(raw, cdpBaseUrl);
  } catch {
    return raw;
  }
}

type CdpTarget = {
  id?: string;
  title?: string;
  url?: string;
  webSocketDebuggerUrl?: string;
  type?: string;
};

export function createProfileTabOps({
  profile,
  state,
  getProfileState,
}: TabOpsDeps): ProfileTabOps {
  const cdpHttpBase = normalizeCdpHttpBaseForJsonEndpoints(profile.cdpUrl);
  const capabilities = getBrowserProfileCapabilities(profile);

  const listTabs = async (): Promise<BrowserTab[]> => {
    if (capabilities.usesChromeMcp) {
      return await listChromeMcpTabs(profile.name);
    }

    if (capabilities.usesPersistentPlaywright) {
      const mod = await getPwAiModule({ mode: "strict" });
      const listPagesViaPlaywright = (mod as Partial<PwAiModule> | null)?.listPagesViaPlaywright;
      if (typeof listPagesViaPlaywright === "function") {
        const pages = await listPagesViaPlaywright({ cdpUrl: profile.cdpUrl });
        return pages.map((p) => ({
          targetId: p.targetId,
          title: p.title,
          url: p.url,
          type: p.type,
        }));
      }
    }

    const raw = await fetchJson<
      Array<{
        id?: string;
        title?: string;
        url?: string;
        webSocketDebuggerUrl?: string;
        type?: string;
      }>
    >(appendCdpPath(cdpHttpBase, "/json/list"));
    return raw
      .map((t) => ({
        targetId: t.id ?? "",
        title: t.title ?? "",
        url: t.url ?? "",
        wsUrl: normalizeWsUrl(t.webSocketDebuggerUrl, profile.cdpUrl),
        type: t.type,
      }))
      .filter((t) => Boolean(t.targetId));
  };

  // ARCH §2.3: at most browser.maxTabs open pages; opening one more closes the oldest page the
  // agent did not mark keep (never the one just opened, never one in use by a tool call).
  const enforceManagedTabLimit = async (keepTargetId: string): Promise<void> => {
    const profileState = getProfileState();
    if (
      !capabilities.supportsManagedTabLimit ||
      state().resolved.attachOnly ||
      !profileState.running
    ) {
      return;
    }

    const pageTabs = await listTabs()
      .then((tabs) => tabs.filter((tab) => (tab.type ?? "page") === "page"))
      .catch(() => [] as BrowserTab[]);
    pruneTabMeta(profileState.tabMeta, pageTabs);
    const evict = selectTabsToEvict({
      pageTabs,
      meta: profileState.tabMeta,
      maxTabs: state().resolved.maxTabs,
      protectTargetId: keepTargetId,
      isInUse: (targetId) => isTabInUse(profile.cdpUrl, targetId),
    });
    for (const tab of evict) {
      profileState.tabMeta?.delete(tab.targetId);
      void fetchOk(appendCdpPath(cdpHttpBase, `/json/close/${tab.targetId}`)).catch(() => {
        // best-effort cleanup only
      });
    }
  };

  const recordOpenedTab = (targetId: string, opts?: OpenTabOptions) => {
    const profileState = getProfileState();
    profileState.lastTargetId = targetId;
    if (!profileState.tabMeta) {
      profileState.tabMeta = new Map();
    }
    profileState.tabMeta.set(targetId, { openedAt: Date.now(), keep: opts?.keep === true });
  };

  const triggerManagedTabLimit = (keepTargetId: string): void => {
    void enforceManagedTabLimit(keepTargetId).catch(() => {
      // best-effort cleanup only
    });
  };

  const openTab = async (url: string, opts?: OpenTabOptions): Promise<BrowserTab> => {
    const ssrfPolicyOpts = withBrowserNavigationPolicy(state().resolved.ssrfPolicy);

    if (capabilities.usesChromeMcp) {
      await assertBrowserNavigationAllowed({ url, ...ssrfPolicyOpts });
      const page = await openChromeMcpTab(profile.name, url);
      const profileState = getProfileState();
      profileState.lastTargetId = page.targetId;
      await assertBrowserNavigationResultAllowed({ url: page.url, ...ssrfPolicyOpts });
      return page;
    }

    if (capabilities.usesPersistentPlaywright) {
      const mod = await getPwAiModule({ mode: "strict" });
      const createPageViaPlaywright = (mod as Partial<PwAiModule> | null)?.createPageViaPlaywright;
      if (typeof createPageViaPlaywright === "function") {
        const page = await createPageViaPlaywright({
          cdpUrl: profile.cdpUrl,
          url,
          ...ssrfPolicyOpts,
        });
        recordOpenedTab(page.targetId, opts);
        triggerManagedTabLimit(page.targetId);
        return {
          targetId: page.targetId,
          title: page.title,
          url: page.url,
          type: page.type,
        };
      }
    }

    if (requiresInspectableBrowserNavigationRedirects(state().resolved.ssrfPolicy)) {
      throw new InvalidBrowserNavigationUrlError(
        "Navigation blocked: strict browser SSRF policy requires Playwright-backed redirect-hop inspection",
      );
    }

    const createdViaCdp = await createTargetViaCdp({
      cdpUrl: profile.cdpUrl,
      url,
      ...ssrfPolicyOpts,
    })
      .then((r) => r.targetId)
      .catch(() => null);

    if (createdViaCdp) {
      recordOpenedTab(createdViaCdp, opts);
      const deadline = Date.now() + OPEN_TAB_DISCOVERY_WINDOW_MS;
      while (Date.now() < deadline) {
        const tabs = await listTabs().catch(() => [] as BrowserTab[]);
        const found = tabs.find((t) => t.targetId === createdViaCdp);
        if (found) {
          await assertBrowserNavigationResultAllowed({ url: found.url, ...ssrfPolicyOpts });
          triggerManagedTabLimit(found.targetId);
          return found;
        }
        await new Promise((r) => setTimeout(r, OPEN_TAB_DISCOVERY_POLL_MS));
      }
      triggerManagedTabLimit(createdViaCdp);
      return { targetId: createdViaCdp, title: "", url, type: "page" };
    }

    const encoded = encodeURIComponent(url);
    const endpointUrl = new URL(appendCdpPath(cdpHttpBase, "/json/new"));
    await assertBrowserNavigationAllowed({ url, ...ssrfPolicyOpts });
    const endpoint = endpointUrl.search
      ? (() => {
          endpointUrl.searchParams.set("url", url);
          return endpointUrl.toString();
        })()
      : `${endpointUrl.toString()}?${encoded}`;
    const created = await fetchJson<CdpTarget>(endpoint, CDP_JSON_NEW_TIMEOUT_MS, {
      method: "PUT",
    }).catch(async (err) => {
      if (String(err).includes("HTTP 405")) {
        return await fetchJson<CdpTarget>(endpoint, CDP_JSON_NEW_TIMEOUT_MS);
      }
      throw err;
    });

    if (!created.id) {
      throw new Error("Failed to open tab (missing id)");
    }
    recordOpenedTab(created.id, opts);
    const resolvedUrl = created.url ?? url;
    await assertBrowserNavigationResultAllowed({ url: resolvedUrl, ...ssrfPolicyOpts });
    triggerManagedTabLimit(created.id);
    return {
      targetId: created.id,
      title: created.title ?? "",
      url: resolvedUrl,
      wsUrl: normalizeWsUrl(created.webSocketDebuggerUrl, profile.cdpUrl),
      type: created.type,
    };
  };

  return {
    listTabs,
    openTab,
  };
}
