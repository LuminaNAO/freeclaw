import path from "node:path";
import {
  parseAgentSessionKey,
  resolveSignalAccount,
  signalRpcRequest,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/model-badge";
import type { ProviderFactory } from "../registry.js";
import { createClientRpc, createSignalProvider, type SignalEndpoint } from "./provider.js";

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

// Resolves the configured freeclaw Signal account to its daemon endpoint with freeclaw's
// own account resolution (HTTP URL, endpoint file, or the account's unix socket).
export function resolveSignalEndpoint(
  gatewayConfig: unknown,
  accountId: string | null,
): SignalEndpoint {
  try {
    const acct = resolveSignalAccount({ cfg: gatewayConfig as OpenClawConfig, accountId });
    return {
      baseUrl: acct.baseUrl,
      account: str(acct.config.account),
      transportError: acct.transportError,
    };
  } catch (err) {
    return { baseUrl: "", account: null, transportError: String((err as Error)?.message ?? err) };
  }
}

export const signalProviderFactory: ProviderFactory = (ctx) => {
  const accountId = str(ctx.block.accountId);
  const endpoint = resolveSignalEndpoint(ctx.gatewayConfig, accountId);
  const profileBaseImage = str(ctx.block.profileBaseImage);
  const provider = createSignalProvider({
    config: {
      agentId: ctx.agentId,
      accountId,
      profileSessionKey: str(ctx.block.profileSessionKey),
      profileBaseImage:
        profileBaseImage && path.isAbsolute(profileBaseImage) ? profileBaseImage : null,
    },
    endpoint,
    rpc: createClientRpc((method, params, opts) => signalRpcRequest(method, params, opts), {
      baseUrl: endpoint.baseUrl,
      timeoutMs: ctx.rpcTimeoutMs,
    }),
    parseSessionKey: parseAgentSessionKey,
    clock: ctx.clock,
  });
  const configError = provider.configError.bind(provider);
  return Object.assign(provider, {
    configError: () =>
      profileBaseImage && !path.isAbsolute(profileBaseImage)
        ? "signal.profileBaseImage must be an absolute path"
        : configError(),
  });
};
