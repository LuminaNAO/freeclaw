import type { AgentMessage } from "@mariozechner/pi-agent-core";

export const CHARS_PER_TOKEN_ESTIMATE = 4;
const IMAGE_CHAR_ESTIMATE = 8_000;

/**
 * The guard estimates the WIRE payload, not the persisted transcript:
 * tool-result `details` never reach the provider, and assistant thinking is
 * only counted when the provider replays it (see includeThinking). One
 * chars-per-token constant applies to content and budget alike.
 */
export type MessageCharEstimateOptions = {
  /** Count persisted assistant thinking blocks. Pass false when the provider
   * does not replay them (for example llama.cpp, where FreeClaw drops
   * thinking blocks before the request is built). Default: true. */
  includeThinking?: boolean;
};

export type MessageCharEstimateCache = {
  map: WeakMap<AgentMessage, number>;
  includeThinking: boolean;
};

function isTextBlock(block: unknown): block is { type: "text"; text: string } {
  return !!block && typeof block === "object" && (block as { type?: unknown }).type === "text";
}

function isImageBlock(block: unknown): boolean {
  return !!block && typeof block === "object" && (block as { type?: unknown }).type === "image";
}

function estimateUnknownChars(value: unknown): number {
  if (typeof value === "string") {
    return value.length;
  }
  if (value === undefined) {
    return 0;
  }
  try {
    const serialized = JSON.stringify(value);
    return typeof serialized === "string" ? serialized.length : 0;
  } catch {
    return 256;
  }
}

export function isToolResultMessage(msg: AgentMessage): boolean {
  const role = (msg as { role?: unknown }).role;
  const type = (msg as { type?: unknown }).type;
  return role === "toolResult" || role === "tool" || type === "toolResult";
}

function getToolResultContent(msg: AgentMessage): unknown[] {
  if (!isToolResultMessage(msg)) {
    return [];
  }
  const content = (msg as { content?: unknown }).content;
  if (typeof content === "string") {
    return [{ type: "text", text: content }];
  }
  return Array.isArray(content) ? content : [];
}

function estimateContentBlockChars(content: unknown[]): number {
  let chars = 0;
  for (const block of content) {
    if (isTextBlock(block)) {
      chars += block.text.length;
    } else if (isImageBlock(block)) {
      chars += IMAGE_CHAR_ESTIMATE;
    } else {
      chars += estimateUnknownChars(block);
    }
  }
  return chars;
}

export function getToolResultText(msg: AgentMessage): string {
  const content = getToolResultContent(msg);
  const chunks: string[] = [];
  for (const block of content) {
    if (isTextBlock(block)) {
      chunks.push(block.text);
    }
  }
  return chunks.join("\n");
}

export type ContextCharsBreakdown = {
  /** User message text plus assistant visible text and tool-call arguments. */
  textChars: number;
  /** Persisted assistant thinking blocks (counted on the wire only when the
   * provider replays them). */
  thinkingChars: number;
  /** Tool result content chars. */
  toolChars: number;
  /** Tool result details chars (persisted but never sent on the wire). */
  detailsChars: number;
  /** Total on the cache's wire semantics, identical to estimateContextChars()
   * on the same messages and cache. */
  totalChars: number;
};

function estimateMessageChars(msg: AgentMessage, includeThinking: boolean): number {
  if (!msg || typeof msg !== "object") {
    return 0;
  }

  if (msg.role === "user") {
    const content = msg.content;
    if (typeof content === "string") {
      return content.length;
    }
    if (Array.isArray(content)) {
      return estimateContentBlockChars(content);
    }
    return 0;
  }

  if (msg.role === "assistant") {
    let chars = 0;
    const content = (msg as { content?: unknown }).content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (!block || typeof block !== "object") {
          continue;
        }
        const typed = block as {
          type?: unknown;
          text?: unknown;
          thinking?: unknown;
          arguments?: unknown;
        };
        if (typed.type === "text" && typeof typed.text === "string") {
          chars += typed.text.length;
        } else if (typed.type === "thinking" && typeof typed.thinking === "string") {
          if (includeThinking) {
            chars += typed.thinking.length;
          }
        } else if (typed.type === "toolCall") {
          try {
            chars += JSON.stringify(typed.arguments ?? {}).length;
          } catch {
            chars += 128;
          }
        } else {
          chars += estimateUnknownChars(block);
        }
      }
    }
    return chars;
  }

  if (isToolResultMessage(msg)) {
    // Content only: `details` is internal metadata that never reaches the wire.
    return estimateContentBlockChars(getToolResultContent(msg));
  }

  return 256;
}

export function createMessageCharEstimateCache(
  opts?: MessageCharEstimateOptions,
): MessageCharEstimateCache {
  return {
    map: new WeakMap<AgentMessage, number>(),
    includeThinking: opts?.includeThinking ?? true,
  };
}

export function estimateMessageCharsCached(
  msg: AgentMessage,
  cache: MessageCharEstimateCache,
): number {
  const hit = cache.map.get(msg);
  if (hit !== undefined) {
    return hit;
  }
  const estimated = estimateMessageChars(msg, cache.includeThinking);
  cache.map.set(msg, estimated);
  return estimated;
}

export function estimateContextChars(
  messages: AgentMessage[],
  cache: MessageCharEstimateCache,
): number {
  return messages.reduce((sum, msg) => sum + estimateMessageCharsCached(msg, cache), 0);
}

/**
 * Per-category breakdown of the context estimate, for guard decision logging.
 * Parts are raw transcript chars — the same vocabulary as the divergence
 * analysis — while totalChars follows the cache's wire semantics so it can be
 * compared against the guard budget.
 */
export function estimateContextCharsBreakdown(
  messages: AgentMessage[],
  cache: MessageCharEstimateCache,
): ContextCharsBreakdown {
  const breakdown: ContextCharsBreakdown = {
    textChars: 0,
    thinkingChars: 0,
    toolChars: 0,
    detailsChars: 0,
    totalChars: 0,
  };

  for (const msg of messages) {
    if (!msg || typeof msg !== "object") {
      continue;
    }
    breakdown.totalChars += estimateMessageCharsCached(msg, cache);

    if (msg.role === "user") {
      const content = msg.content;
      breakdown.textChars +=
        typeof content === "string"
          ? content.length
          : Array.isArray(content)
            ? estimateContentBlockChars(content)
            : 0;
      continue;
    }

    if (msg.role === "assistant") {
      const content = (msg as { content?: unknown }).content;
      if (!Array.isArray(content)) {
        continue;
      }
      for (const block of content) {
        if (!block || typeof block !== "object") {
          continue;
        }
        const typed = block as { type?: unknown; text?: unknown; thinking?: unknown };
        if (typed.type === "thinking" && typeof typed.thinking === "string") {
          breakdown.thinkingChars += typed.thinking.length;
        } else if (typed.type === "text" && typeof typed.text === "string") {
          breakdown.textChars += typed.text.length;
        } else if (typed.type === "toolCall") {
          // Mirrors estimateMessageChars: only the serialized arguments count.
          const args = (block as { arguments?: unknown }).arguments;
          try {
            breakdown.textChars += JSON.stringify(args ?? {}).length;
          } catch {
            breakdown.textChars += 128;
          }
        } else {
          breakdown.textChars += estimateUnknownChars(block);
        }
      }
      continue;
    }

    if (isToolResultMessage(msg)) {
      breakdown.toolChars += estimateContentBlockChars(getToolResultContent(msg));
      const details = (msg as { details?: unknown }).details;
      breakdown.detailsChars += details === undefined ? 0 : estimateUnknownChars(details);
    }
  }

  return breakdown;
}

export function invalidateMessageCharsCacheEntry(
  cache: MessageCharEstimateCache,
  msg: AgentMessage,
): void {
  cache.map.delete(msg);
}
