import type { OpenClawConfig } from "../../config/config.js";
import type { ExecAsk, ExecHost, ExecSecurity } from "../../infra/exec-approvals.js";
import { extractModelDirective } from "../model.js";
import type { MsgContext } from "../templating.js";
import type { ElevatedLevel, ReasoningLevel, ThinkLevel, VerboseLevel } from "./directives.js";
import {
  extractElevatedDirective,
  extractExecDirective,
  extractFastDirective,
  extractReasoningDirective,
  extractStatusDirective,
  extractThinkDirective,
  extractVerboseDirective,
} from "./directives.js";
import { stripMentions, stripStructuralPrefixes } from "./mentions.js";
import type { QueueDropPolicy, QueueMode } from "./queue.js";
import { extractQueueDirective } from "./queue.js";

export type InlineDirectives = {
  cleaned: string;
  hasThinkDirective: boolean;
  thinkLevel?: ThinkLevel;
  rawThinkLevel?: string;
  hasVerboseDirective: boolean;
  verboseLevel?: VerboseLevel;
  rawVerboseLevel?: string;
  hasFastDirective: boolean;
  fastMode?: boolean;
  rawFastMode?: string;
  hasReasoningDirective: boolean;
  reasoningLevel?: ReasoningLevel;
  rawReasoningLevel?: string;
  hasElevatedDirective: boolean;
  elevatedLevel?: ElevatedLevel;
  rawElevatedLevel?: string;
  hasExecDirective: boolean;
  execHost?: ExecHost;
  execSecurity?: ExecSecurity;
  execAsk?: ExecAsk;
  execNode?: string;
  rawExecHost?: string;
  rawExecSecurity?: string;
  rawExecAsk?: string;
  rawExecNode?: string;
  hasExecOptions: boolean;
  invalidExecHost: boolean;
  invalidExecSecurity: boolean;
  invalidExecAsk: boolean;
  invalidExecNode: boolean;
  hasStatusDirective: boolean;
  hasModelDirective: boolean;
  rawModelDirective?: string;
  rawModelProfile?: string;
  hasQueueDirective: boolean;
  queueMode?: QueueMode;
  queueReset: boolean;
  rawQueueMode?: string;
  debounceMs?: number;
  cap?: number;
  dropPolicy?: QueueDropPolicy;
  rawDebounce?: string;
  rawCap?: string;
  rawDrop?: string;
  hasQueueOptions: boolean;
};

type ParseDirectiveOptions = {
  modelAliases?: string[];
  disableElevated?: boolean;
  allowStatusDirective?: boolean;
};

function parseDirectivePass(body: string, options?: ParseDirectiveOptions): InlineDirectives {
  const {
    cleaned: thinkCleaned,
    thinkLevel,
    rawLevel: rawThinkLevel,
    hasDirective: hasThinkDirective,
  } = extractThinkDirective(body);
  const {
    cleaned: verboseCleaned,
    verboseLevel,
    rawLevel: rawVerboseLevel,
    hasDirective: hasVerboseDirective,
  } = extractVerboseDirective(thinkCleaned);
  const {
    cleaned: fastCleaned,
    fastMode,
    rawLevel: rawFastMode,
    hasDirective: hasFastDirective,
  } = extractFastDirective(verboseCleaned);
  const {
    cleaned: reasoningCleaned,
    reasoningLevel,
    rawLevel: rawReasoningLevel,
    hasDirective: hasReasoningDirective,
  } = extractReasoningDirective(fastCleaned);
  const {
    cleaned: elevatedCleaned,
    elevatedLevel,
    rawLevel: rawElevatedLevel,
    hasDirective: hasElevatedDirective,
  } = options?.disableElevated
    ? {
        cleaned: reasoningCleaned,
        elevatedLevel: undefined,
        rawLevel: undefined,
        hasDirective: false,
      }
    : extractElevatedDirective(reasoningCleaned);
  const {
    cleaned: execCleaned,
    execHost,
    execSecurity,
    execAsk,
    execNode,
    rawExecHost,
    rawExecSecurity,
    rawExecAsk,
    rawExecNode,
    hasExecOptions,
    invalidHost: invalidExecHost,
    invalidSecurity: invalidExecSecurity,
    invalidAsk: invalidExecAsk,
    invalidNode: invalidExecNode,
    hasDirective: hasExecDirective,
  } = extractExecDirective(elevatedCleaned);
  const allowStatusDirective = options?.allowStatusDirective !== false;
  const { cleaned: statusCleaned, hasDirective: hasStatusDirective } = allowStatusDirective
    ? extractStatusDirective(execCleaned)
    : { cleaned: execCleaned, hasDirective: false };
  const {
    cleaned: modelCleaned,
    rawModel,
    rawProfile,
    hasDirective: hasModelDirective,
  } = extractModelDirective(statusCleaned, {
    aliases: options?.modelAliases,
  });
  const {
    cleaned: queueCleaned,
    queueMode,
    queueReset,
    rawMode,
    debounceMs,
    cap,
    dropPolicy,
    rawDebounce,
    rawCap,
    rawDrop,
    hasDirective: hasQueueDirective,
    hasOptions: hasQueueOptions,
  } = extractQueueDirective(modelCleaned);

  return {
    cleaned: queueCleaned,
    hasThinkDirective,
    thinkLevel,
    rawThinkLevel,
    hasVerboseDirective,
    verboseLevel,
    rawVerboseLevel,
    hasFastDirective,
    fastMode,
    rawFastMode,
    hasReasoningDirective,
    reasoningLevel,
    rawReasoningLevel,
    hasElevatedDirective,
    elevatedLevel,
    rawElevatedLevel,
    hasExecDirective,
    execHost,
    execSecurity,
    execAsk,
    execNode,
    rawExecHost,
    rawExecSecurity,
    rawExecAsk,
    rawExecNode,
    hasExecOptions,
    invalidExecHost,
    invalidExecSecurity,
    invalidExecAsk,
    invalidExecNode,
    hasStatusDirective,
    hasModelDirective,
    rawModelDirective: rawModel,
    rawModelProfile: rawProfile,
    hasQueueDirective,
    queueMode,
    queueReset,
    rawQueueMode: rawMode,
    debounceMs,
    cap,
    dropPolicy,
    rawDebounce,
    rawCap,
    rawDrop,
    hasQueueOptions,
  };
}

export function isDirectiveOnly(params: {
  directives: InlineDirectives;
  cleanedBody: string;
  ctx: MsgContext;
  cfg: OpenClawConfig;
  agentId?: string;
  isGroup: boolean;
}): boolean {
  const { directives, cleanedBody, ctx, cfg, agentId, isGroup } = params;
  if (
    !directives.hasThinkDirective &&
    !directives.hasVerboseDirective &&
    !directives.hasFastDirective &&
    !directives.hasReasoningDirective &&
    !directives.hasElevatedDirective &&
    !directives.hasExecDirective &&
    !directives.hasModelDirective &&
    !directives.hasQueueDirective
  ) {
    return false;
  }
  const stripped = stripStructuralPrefixes(cleanedBody ?? "");
  const noMentions = isGroup ? stripMentions(stripped, ctx, cfg, agentId) : stripped;
  return noMentions.length === 0;
}

const DIRECTIVE_FIELD_GROUPS: Array<{
  flag: keyof InlineDirectives;
  fields: Array<keyof InlineDirectives>;
}> = [
  { flag: "hasThinkDirective", fields: ["thinkLevel", "rawThinkLevel"] },
  { flag: "hasVerboseDirective", fields: ["verboseLevel", "rawVerboseLevel"] },
  { flag: "hasFastDirective", fields: ["fastMode", "rawFastMode"] },
  { flag: "hasReasoningDirective", fields: ["reasoningLevel", "rawReasoningLevel"] },
  { flag: "hasElevatedDirective", fields: ["elevatedLevel", "rawElevatedLevel"] },
  {
    flag: "hasExecDirective",
    fields: [
      "execHost",
      "execSecurity",
      "execAsk",
      "execNode",
      "rawExecHost",
      "rawExecSecurity",
      "rawExecAsk",
      "rawExecNode",
      "hasExecOptions",
      "invalidExecHost",
      "invalidExecSecurity",
      "invalidExecAsk",
      "invalidExecNode",
    ],
  },
  { flag: "hasStatusDirective", fields: [] },
  { flag: "hasModelDirective", fields: ["rawModelDirective", "rawModelProfile"] },
  {
    flag: "hasQueueDirective",
    fields: [
      "queueMode",
      "queueReset",
      "rawQueueMode",
      "debounceMs",
      "cap",
      "dropPolicy",
      "rawDebounce",
      "rawCap",
      "rawDrop",
      "hasQueueOptions",
    ],
  },
];

const MAX_LEADING_DIRECTIVE_PASSES = 16;

/**
 * Parse the leading run of directives in `body`.
 *
 * Only a message whose first non-whitespace character is `/` can carry directives
 * (docs/design/no-embedded-slash-commands.md §2.1/§2.3). Every extractor is anchored
 * to the start of the remaining text, so a directive-looking token after ordinary
 * text is plain text and stays in `cleaned`. Passes repeat so that a leading run of
 * several directives is consumed regardless of their order.
 */
export function parseInlineDirectives(
  body: string,
  options?: ParseDirectiveOptions,
): InlineDirectives {
  const result = parseDirectivePass(body, options);
  for (let pass = 1; pass < MAX_LEADING_DIRECTIVE_PASSES; pass += 1) {
    if (!result.cleaned.startsWith("/")) {
      break;
    }
    const next = parseDirectivePass(result.cleaned, options);
    if (next.cleaned === result.cleaned) {
      break;
    }
    const merged = result as Record<keyof InlineDirectives, unknown>;
    let addedDirective = false;
    for (const group of DIRECTIVE_FIELD_GROUPS) {
      if (next[group.flag] && !result[group.flag]) {
        addedDirective = true;
        merged[group.flag] = true;
        for (const field of group.fields) {
          merged[field] = next[field];
        }
      }
    }
    if (!addedDirective) {
      // A repeated directive ends the leading run (one occurrence per directive, as before).
      break;
    }
    result.cleaned = next.cleaned;
  }
  return result;
}
