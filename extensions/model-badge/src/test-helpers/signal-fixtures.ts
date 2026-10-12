import type { RpcOutcome } from "../providers/signal/classify.js";

// Synthetic signal-cli JSON-RPC responses. No live Signal was used: each shape follows
// signal-cli's documented JSON output for updateGroup / updateProfile / listGroups. All
// ids and numbers are obviously fake placeholders.

export const ACCOUNT = "+10000000000";
export const OTHER = "+10000000009";

const rpc = (body: Record<string, unknown>): Record<string, any> => ({
  jsonrpc: "2.0",
  id: 1,
  ...body,
});

// Success: {timestamp, results:[{recipientAddress, type}]}.
export const updateOk = (n = 3) =>
  rpc({
    result: {
      timestamp: 1_700_000_000_000,
      results: Array.from({ length: n }, (_, i) => ({
        recipientAddress: { number: `+1000000010${i}` },
        type: "SUCCESS",
      })),
    },
  });

// One recipient hit a plain rate limit: committed, but the account is limited.
export const updateRateLimited = () => {
  const r = updateOk(4);
  r.result.results.push({
    recipientAddress: { number: "+10000000199" },
    type: "RATE_LIMIT_FAILURE",
  });
  return r;
};

// Proof required: the entry carries a token and retryAfterSeconds.
export const updateCaptcha = (retryAfterSeconds = 7200) => {
  const r = updateOk(2);
  r.result.results.push({
    recipientAddress: { number: "+10000000198" },
    type: "RATE_LIMIT_FAILURE",
    token: "00000000-0000-0000-0000-000000000000",
    retryAfterSeconds,
  });
  return r;
};

export const errGroupNotFound = () =>
  rpc({ error: { code: -1, message: "Group not found: RkFLRUZBS0VGQUtFRkFLRUZBS0U=" } });
export const errNotMember = () =>
  rpc({
    error: {
      code: -1,
      message: "User is not a member in group: Fake Group (RkFLRUZBS0VGQUtFRkFLRUZBS0U=)",
    },
  });
export const errNotAllowed = () =>
  rpc({
    error: {
      code: -1,
      message:
        "User is not allowed to send message to group: Fake Group (RkFLRUZBS0VGQUtFRkFLRUZBS0U=)",
    },
  });
export const errIo = () =>
  rpc({
    error: {
      code: -32603,
      message:
        "Failed to send message: Connection reset (SocketException) (UnexpectedErrorException)",
    },
  });
export const errAvatarMissing = (avatarPath: string) =>
  rpc({
    error: {
      code: -32603,
      message: `Failed to send message: ${avatarPath} (No such file or directory) (FileNotFoundException) (UnexpectedErrorException)`,
    },
  });
export const errProfileAvatarUnreadable = (avatarPath: string) =>
  rpc({ error: { code: -3, message: `Update profile error: ${avatarPath} (Permission denied)` } });
export const errProfileIo = () =>
  rpc({ error: { code: -3, message: "Update profile error: Connection reset" } });
// DEFENSIVE FALLBACK ONLY: updateGroup never raises -5 today.
export const errRateLimitFallback = () => rpc({ error: { code: -5, message: "Rate limit" } });

export function group(
  id: string,
  o: { member?: boolean; admin?: boolean; edit?: "EVERY_MEMBER" | "ONLY_ADMINS" } = {},
) {
  return {
    id,
    name: "Fake Group",
    isMember: o.member ?? true,
    members: [
      { number: ACCOUNT, uuid: "00000000-0000-4000-8000-000000000001", isAdmin: o.admin ?? false },
      { number: OTHER, uuid: "00000000-0000-4000-8000-000000000002", isAdmin: true },
    ],
    permissionEditDetails: o.edit ?? "EVERY_MEMBER",
  };
}

export const listGroups = (groups: unknown[]) => rpc({ result: groups });

// As the transport outcome the provider's rpc returns.
export const ok = (body: unknown): RpcOutcome => ({ transport: "ok", body: body as never });
