// Mail connector filter (docs/design/mail-push.md §3 `filter`): all set conditions are AND-ed.
import type { MailConnectorFilterConfig } from "../config/types.mail.js";
import type { MailAddress, MailMessage } from "./types.js";

const globCache = new Map<string, RegExp>();

function globToRegExp(glob: string): RegExp {
  const key = glob.trim().toLowerCase();
  const cached = globCache.get(key);
  if (cached) {
    return cached;
  }
  const source = key
    .split("")
    .map((char) => {
      if (char === "*") {
        return ".*";
      }
      if (char === "?") {
        return ".";
      }
      return char.replace(/[.+^${}()|[\]\\/]/g, "\\$&");
    })
    .join("");
  const re = new RegExp(`^${source}$`, "i");
  globCache.set(key, re);
  return re;
}

/** True when the address matches one of the globs (case-insensitive, `*` and `?` wildcards). */
export function matchesAddressGlob(address: string | undefined, globs: string[]): boolean {
  const value = address?.trim().toLowerCase();
  if (!value) {
    return false;
  }
  return globs.some((glob) => globToRegExp(glob).test(value));
}

function anyAddressMatches(addresses: MailAddress[], globs: string[]): boolean {
  return addresses.some((entry) => matchesAddressGlob(entry.address, globs));
}

function nonEmpty(list: string[] | undefined): list is string[] {
  return Array.isArray(list) && list.length > 0;
}

/** Why a message is dropped, or null when it passes. Reasons never include mail content. */
export function mailFilterRejection(
  message: MailMessage,
  filter: MailConnectorFilterConfig | undefined,
  nowMs: number,
): string | null {
  if (!filter) {
    return null;
  }
  if (nonEmpty(filter.from) && !anyAddressMatches(message.from, filter.from)) {
    return "from";
  }
  if (nonEmpty(filter.excludeFrom) && anyAddressMatches(message.from, filter.excludeFrom)) {
    return "excludeFrom";
  }
  if (nonEmpty(filter.to) && !anyAddressMatches([...message.to, ...message.cc], filter.to)) {
    return "to";
  }
  if (nonEmpty(filter.subjectIncludes)) {
    const subject = (message.subject ?? "").toLowerCase();
    if (!filter.subjectIncludes.some((needle) => subject.includes(needle.toLowerCase()))) {
      return "subjectIncludes";
    }
  }
  if (typeof filter.maxAgeMinutes === "number" && message.date) {
    const ageMs = nowMs - message.date.getTime();
    if (Number.isFinite(ageMs) && ageMs > filter.maxAgeMinutes * 60_000) {
      return "maxAgeMinutes";
    }
  }
  return null;
}
