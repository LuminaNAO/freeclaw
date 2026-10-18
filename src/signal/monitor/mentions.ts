import type { SignalMention } from "./event-handler.types.js";

const OBJECT_REPLACEMENT = "\uFFFC";

function isValidMention(mention: SignalMention | null | undefined): mention is SignalMention {
  if (!mention) {
    return false;
  }
  if (!(mention.uuid || mention.number)) {
    return false;
  }
  if (typeof mention.start !== "number" || Number.isNaN(mention.start)) {
    return false;
  }
  if (typeof mention.length !== "number" || Number.isNaN(mention.length)) {
    return false;
  }
  return mention.length > 0;
}

function clampBounds(start: number, length: number, textLength: number) {
  const safeStart = Math.max(0, Math.trunc(start));
  const safeLength = Math.max(0, Math.trunc(length));
  const safeEnd = Math.min(textLength, safeStart + safeLength);
  return { start: safeStart, end: safeEnd };
}

export function renderSignalMentions(message: string, mentions?: SignalMention[] | null) {
  if (!message || !mentions?.length) {
    return message;
  }

  let normalized = message;
  const candidates = mentions.filter(isValidMention).toSorted((a, b) => b.start! - a.start!);

  for (const mention of candidates) {
    const identifier = mention.uuid ?? mention.number;
    if (!identifier) {
      continue;
    }

    const { start, end } = clampBounds(mention.start!, mention.length!, normalized.length);
    if (start >= end) {
      continue;
    }
    const slice = normalized.slice(start, end);

    if (!slice.includes(OBJECT_REPLACEMENT)) {
      continue;
    }

    normalized = normalized.slice(0, start) + `@${identifier}` + normalized.slice(end);
  }

  return normalized;
}

/**
 * Agent peers ARCH §2.2: true when Signal's native mention metadata addresses our own account
 * (by account uuid or account number).
 */
export function mentionsSignalAccount(
  mentions: SignalMention[] | null | undefined,
  account: { uuid?: string; number?: string },
): boolean {
  if (!mentions?.length) {
    return false;
  }
  const uuid = account.uuid?.trim().toLowerCase() || undefined;
  const number = account.number?.trim() || undefined;
  if (!uuid && !number) {
    return false;
  }
  return mentions.some((mention) => {
    if (!mention) {
      return false;
    }
    const mentionUuid = mention.uuid?.trim().toLowerCase();
    if (uuid && mentionUuid && mentionUuid === uuid) {
      return true;
    }
    const mentionNumber = mention.number?.trim();
    return Boolean(number && mentionNumber && mentionNumber === number);
  });
}
