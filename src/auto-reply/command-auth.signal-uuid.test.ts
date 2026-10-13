/**
 * docs/design/signal-uuid-identity.md §3.1 — command/owner authorization for a uuid
 * Signal sender: a legacy phone allowFrom entry still authorizes via the secondary
 * number (no lock-outs), but the reported sender id stays the uuid. Placeholders only.
 */
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resolveCommandAuthorization } from "./command-auth.js";
import { resolveElevatedPermissions } from "./reply/reply-elevated.js";
import type { MsgContext } from "./templating.js";

const UUID = "00000000-0000-4000-8000-00000000000a";
const NUMBER = "+15550001111";

function signalCtx(overrides: Partial<MsgContext> = {}): MsgContext {
  return {
    Provider: "signal",
    Surface: "signal",
    ChatType: "direct",
    From: `signal:${UUID}`,
    To: UUID,
    SenderId: `uuid:${UUID}`,
    SenderMatchE164: NUMBER,
    ...overrides,
  } as MsgContext;
}

// Owner matching is what shared command auth decides for Signal (channel-level command
// gating happens in the Signal event handler); commands.ownerAllowFrom makes it explicit.
function auth(ownerAllowFrom: string[], ctx: MsgContext = signalCtx()) {
  const cfg = {
    channels: { signal: { allowFrom: ownerAllowFrom } },
    commands: { ownerAllowFrom: ownerAllowFrom.map((entry) => `signal:${entry}`) },
  } as OpenClawConfig;
  return resolveCommandAuthorization({ ctx, cfg, commandAuthorized: true });
}

describe("owner authorization for uuid Signal senders", () => {
  it("a uuid owner entry matches; sender id is uuid:<uuid>", () => {
    const result = auth([`uuid:${UUID}`]);
    expect(result.senderIsOwner).toBe(true);
    expect(result.senderId).toBe(`uuid:${UUID}`);
  });

  it("a legacy phone owner entry still matches via the secondary number", () => {
    const result = auth([NUMBER]);
    expect(result.senderIsOwner).toBe(true);
    // the number is never reported as the sender id
    expect(result.senderId).toBe(`uuid:${UUID}`);
  });

  it("a mismatched owner entry does not match", () => {
    expect(auth(["+15550003333"]).senderIsOwner).toBe(false);
    expect(auth([NUMBER], signalCtx({ SenderMatchE164: undefined })).senderIsOwner).toBe(false);
  });

  it("owner formatting keeps uuids intact (no digit mangling)", () => {
    const result = auth([UUID.toUpperCase()]);
    expect(result.ownerList).toEqual([`uuid:${UUID}`]);
    expect(result.senderIsOwner).toBe(true);
  });
});

describe("elevated allowFrom for uuid Signal senders", () => {
  function elevated(allowFrom: string[], ctx: MsgContext = signalCtx()) {
    return resolveElevatedPermissions({
      cfg: { tools: { elevated: { allowFrom: { signal: allowFrom } } } } as OpenClawConfig,
      agentId: "main",
      provider: "signal",
      ctx,
    });
  }

  it("matches a uuid entry and a legacy phone entry; denies a mismatch", () => {
    expect(elevated([`uuid:${UUID}`]).allowed).toBe(true);
    expect(elevated([NUMBER]).allowed).toBe(true);
    expect(elevated(["+15550003333"]).allowed).toBe(false);
  });
});
