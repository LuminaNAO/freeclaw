import { describe, expectTypeOf, it } from "vitest";
import type { PluginHookMessageContext as SdkMessageContext } from "../plugin-sdk/swarm.js";
import type { PluginHookHandlerMap, PluginHookMessageContext } from "./types.js";

// model-badge ARCH §2c.14 core prerequisite: the message hook context carries an optional
// sessionKey (set by Signal's reply path only); nothing else about it changes.
describe("PluginHookMessageContext type surface", () => {
  it("has an optional sessionKey, also through the plugin-sdk surface", () => {
    expectTypeOf<PluginHookMessageContext>().toEqualTypeOf<{
      channelId: string;
      accountId?: string;
      conversationId?: string;
      sessionKey?: string;
    }>();
    expectTypeOf<SdkMessageContext>().toEqualTypeOf<PluginHookMessageContext>();
    expectTypeOf<{ channelId: string }>().toMatchTypeOf<PluginHookMessageContext>();
    expectTypeOf<
      Parameters<PluginHookHandlerMap["message_sent"]>[1]
    >().toEqualTypeOf<PluginHookMessageContext>();
  });
});
