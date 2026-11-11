// Silence wording shared by the group intro and the `no_reply` tool rewrite (no-reply-tool §6).

/** Group-intro silence line teaching the NO_REPLY token. */
export function buildGroupSilenceLine(silentToken: string): string {
  return `If no response is needed, reply with exactly "${silentToken}" (and nothing else) so OpenClaw stays silent. Do not add any other words, punctuation, tags, markdown/code blocks, or explanations.`;
}

/** Group-intro silence line in `no_reply` tool mode. */
export const GROUP_SILENCE_TOOL_LINE =
  "If no response is needed, call the `no_reply` tool and do nothing else so OpenClaw stays silent. Do not write any text before or after it.";
