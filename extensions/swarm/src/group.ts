// Optional channel group per taskmaster (ARCH §1.5, §9). The MVP ships only "none":
// tasks run identically with no group and no channel.

export interface SwarmGroupAdapter {
  readonly kind: string;
  ensureGroup(taskId: string): Promise<{ ok: boolean; groupId?: string; reason?: string }>;
  post(taskId: string, text: string): Promise<void>;
  dispose(taskId: string): Promise<void>;
}

export const noGroupAdapter: SwarmGroupAdapter = {
  kind: "none",
  async ensureGroup() {
    return { ok: true };
  },
  async post() {},
  async dispose() {},
};

/** Only "none" exists in the MVP; any other kind falls back to it rather than failing a task. */
export function resolveGroupAdapter(kind: string | undefined): SwarmGroupAdapter {
  void kind;
  return noGroupAdapter;
}
