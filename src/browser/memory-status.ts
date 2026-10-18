import type { ResolvedBrowserProfile } from "./config.js";
import {
  bytesToMb,
  measureBrowserTreeRssBytes,
  resolveBrowserMemoryCapMode,
} from "./memory-cap.js";
import type { BrowserMemoryStatus } from "./memory-cap.js";
import { getBrowserProfileCapabilities } from "./profile-capabilities.js";
import type { BrowserServerState, ProfileRuntimeState } from "./server-context.types.js";

/**
 * Build the memory status of one profile (ARCH §2.5-§2.6). A profile counts as managed only when
 * freeclaw launched its browser (local-managed driver and a running handle, or not running yet);
 * anything else (existing-session, extension relay, remote CDP, or a browser already on the port
 * that freeclaw did not start) is reported as external, not capped.
 */
export async function resolveBrowserMemoryStatus(params: {
  state: BrowserServerState;
  profile: ResolvedBrowserProfile;
  profileState?: ProfileRuntimeState;
  tabCount: number | null;
  externallyRunning?: boolean;
  measureRssBytes?: (pid: number) => Promise<number | null>;
}): Promise<BrowserMemoryStatus> {
  const capabilities = getBrowserProfileCapabilities(params.profile);
  const running = params.profileState?.running ?? null;
  const external =
    capabilities.mode !== "local-managed" ||
    params.profile.attachOnly ||
    (!running && params.externallyRunning === true);
  if (external) {
    return {
      scope: "external",
      capMode: "none",
      capMb: null,
      kernelEnforced: false,
      rssMb: null,
      tabCount: params.tabCount,
    };
  }
  const limitMb = params.state.resolved.memoryLimitMb;
  const capMode = running
    ? (running.memoryCap?.mode ?? "off")
    : resolveBrowserMemoryCapMode(limitMb);
  const capMb = capMode === "off" ? null : (running?.memoryCap?.limitMb ?? limitMb);
  let rssMb: number | null = null;
  if (running) {
    const measure = params.measureRssBytes ?? ((pid: number) => measureBrowserTreeRssBytes(pid));
    const rss = await measure(running.pid).catch(() => null);
    rssMb = rss === null ? null : bytesToMb(rss);
  }
  return {
    scope: "managed",
    capMode,
    capMb,
    kernelEnforced: capMode === "kernel",
    rssMb,
    tabCount: params.tabCount,
  };
}
