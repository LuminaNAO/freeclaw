/**
 * Compaction instruction utilities.
 *
 * Provides default language-preservation instructions and a precedence-based
 * resolver for customInstructions used during context compaction summaries.
 */

/**
 * Default instructions injected into every safeguard-mode compaction summary.
 * Preserves conversation language and persona while keeping the SDK's required
 * summary structure intact.
 */
export const DEFAULT_COMPACTION_INSTRUCTIONS =
  "Write the summary body in the primary language used in the conversation.\n" +
  "Focus on factual content: what was discussed, decisions made, and current state.\n" +
  "Keep the required summary structure and section headers unchanged.\n" +
  "Do not translate or alter code, file paths, identifiers, or error messages.";

/**
 * Standing rules every compaction summary keeps, whatever the custom instructions
 * say. They are part of the fixed summary template (not of the 800-char custom
 * budget), so a long /compact instruction cannot push them out.
 *
 * Focus (focus-mode ARCH §7.5): the system prompt's Focus section survives
 * compaction. Its rules are kept; the focus state itself is re-read every turn.
 */
export const FOCUS_COMPACTION_RULE =
  "Keep the rules of the system prompt's ## Focus section under ## Constraints/Rules " +
  "(tiers none < normal < hyper, a session runs only at or above the active level, " +
  "only an operator sets /focus). Do not record the current focus state as a decision: " +
  "it is re-read every turn.";

export const STANDING_COMPACTION_RULES: readonly string[] = [FOCUS_COMPACTION_RULE];

/**
 * Upper bound on custom instruction length to prevent prompt bloat.
 * ~800 chars ≈ ~200 tokens — keeps summarization quality stable.
 */
const MAX_INSTRUCTION_LENGTH = 800;

function truncateUnicodeSafe(s: string, maxCodePoints: number): string {
  const chars = Array.from(s);
  if (chars.length <= maxCodePoints) {
    return s;
  }
  return chars.slice(0, maxCodePoints).join("");
}

function normalize(s: string | undefined): string | undefined {
  if (s == null) {
    return undefined;
  }
  const trimmed = s.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Resolve compaction instructions with precedence:
 *   event (SDK) → runtime (config) → DEFAULT constant.
 *
 * Each input is normalized first (trim + empty→undefined) so that blank
 * strings don't short-circuit the fallback chain.
 */
export function resolveCompactionInstructions(
  eventInstructions: string | undefined,
  runtimeInstructions: string | undefined,
): string {
  const resolved =
    normalize(eventInstructions) ??
    normalize(runtimeInstructions) ??
    DEFAULT_COMPACTION_INSTRUCTIONS;
  return truncateUnicodeSafe(resolved, MAX_INSTRUCTION_LENGTH);
}

/**
 * Compose split-turn instructions by combining the SDK's turn-prefix
 * instructions with the resolved compaction instructions.
 */
export function composeSplitTurnInstructions(
  turnPrefixInstructions: string,
  resolvedInstructions: string,
): string {
  return [turnPrefixInstructions, "Additional requirements:", resolvedInstructions].join("\n\n");
}
