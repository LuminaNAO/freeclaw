import type { AgentMessage } from "@mariozechner/pi-agent-core";

type AssistantContentBlock = Extract<AgentMessage, { role: "assistant" }>["content"][number];
type AssistantMessage = Extract<AgentMessage, { role: "assistant" }>;

export function isAssistantMessageWithContent(message: AgentMessage): message is AssistantMessage {
  return (
    !!message &&
    typeof message === "object" &&
    message.role === "assistant" &&
    Array.isArray(message.content)
  );
}

// Gemma 4 thinking tags that leak into text blocks when the peg-gemma4 parser
// misroutes thinking content. Matches both <channel|> (closing) and
// <|channel> / <|channel|> (opening/full) forms.
const GEMMA4_CHANNEL_TAG_RE = /<[|]?channel[|]?>/g;

/**
 * Detect text blocks that are leaked Gemma 4 thinking content.
 * The peg-gemma4 parser sometimes emits thinking as text blocks that:
 *   - start with "thought\n" (the channel label)
 *   - consist only of a bare closing tag like "<channel|>"
 *   - contain "<channel|>" tags mixed into text
 */
function isLeakedThinkingTextBlock(
  block: AssistantContentBlock,
): block is AssistantContentBlock & { type: "text"; text: string } {
  if (!block || typeof block !== "object") {
    return false;
  }
  const b = block as { type?: string; text?: string };
  if (b.type !== "text" || typeof b.text !== "string") {
    return false;
  }
  const text = b.text.trim();
  if (!text) {
    return false;
  }
  // Bare closing tag or tag-only content
  if (text === "<channel|>" || text === "<|channel>" || text === "<|channel|>") {
    return true;
  }
  // Text block starts with "thought" label — leaked thinking content
  if (text.startsWith("thought\n") || text === "thought") {
    return true;
  }
  return false;
}

/**
 * Strip Gemma 4 channel tags from text content without removing the whole block.
 */
function stripGemma4ChannelTags(text: string): string {
  return text.replace(GEMMA4_CHANNEL_TAG_RE, "").trim();
}

/**
 * Strip all `type: "thinking"` content blocks from assistant messages.
 * Also strips leaked Gemma 4 thinking that ends up in text blocks
 * (bare "thought\n..." content or "<channel|>" tags).
 *
 * If an assistant message becomes empty after stripping, it is replaced with
 * a synthetic `{ type: "text", text: "" }` block to preserve turn structure
 * (some providers require strict user/assistant alternation).
 *
 * Returns the original array reference when nothing was changed (callers can
 * use reference equality to skip downstream work).
 */
export function dropThinkingBlocks(messages: AgentMessage[]): AgentMessage[] {
  let touched = false;
  const out: AgentMessage[] = [];
  for (const msg of messages) {
    if (!isAssistantMessageWithContent(msg)) {
      out.push(msg);
      continue;
    }
    const nextContent: AssistantContentBlock[] = [];
    let changed = false;
    for (const block of msg.content) {
      if (block && typeof block === "object" && (block as { type?: unknown }).type === "thinking") {
        touched = true;
        changed = true;
        continue;
      }
      // Drop text blocks that are entirely leaked thinking content
      if (isLeakedThinkingTextBlock(block)) {
        touched = true;
        changed = true;
        continue;
      }
      // Strip inline channel tags from text blocks that have real content too
      const blockObj = block as unknown as { type?: string; text?: string };
      if (
        blockObj.type === "text" &&
        typeof blockObj.text === "string" &&
        GEMMA4_CHANNEL_TAG_RE.test(blockObj.text)
      ) {
        GEMMA4_CHANNEL_TAG_RE.lastIndex = 0;
        const cleaned = stripGemma4ChannelTags(blockObj.text);
        if (cleaned) {
          nextContent.push({ ...block, text: cleaned } as unknown as AssistantContentBlock);
        }
        touched = true;
        changed = true;
        continue;
      }
      nextContent.push(block);
    }
    if (!changed) {
      out.push(msg);
      continue;
    }
    // Preserve the assistant turn even if all blocks were thinking-only.
    const content =
      nextContent.length > 0 ? nextContent : [{ type: "text", text: "" } as AssistantContentBlock];
    out.push({ ...msg, content });
  }
  return touched ? out : messages;
}
