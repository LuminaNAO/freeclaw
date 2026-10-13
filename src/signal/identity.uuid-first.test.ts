/**
 * docs/design/signal-uuid-identity.md §5 — sender resolution, labels, pairing line and
 * allow-list matching. Placeholder numbers (+1555…) and uuids only.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  formatSignalAllowEntryForMatch,
  formatSignalPairingIdLine,
  formatSignalSenderDisplay,
  formatSignalSenderId,
  isSignalSenderAllowed,
  maskSignalNumber,
  resetSignalLegacyAllowWarningsForTests,
  resolveSignalPeerId,
  resolveSignalRecipient,
  resolveSignalSender,
  toSignalUuidAllowEntry,
} from "./identity.js";

const UUID = "00000000-0000-4000-8000-00000000000a";
const OTHER_UUID = "00000000-0000-4000-8000-00000000000b";
const NUMBER = "+15550001111";
const OTHER_NUMBER = "+15550002222";

afterEach(() => {
  resetSignalLegacyAllowWarningsForTests();
});

describe("resolveSignalSender (§2.1)", () => {
  it("uuid + number envelope -> uuid sender with the number as secondary e164", () => {
    expect(resolveSignalSender({ sourceUuid: UUID, sourceNumber: NUMBER })).toEqual({
      kind: "uuid",
      raw: UUID,
      e164: NUMBER,
    });
  });

  it("number-only envelope -> phone sender", () => {
    expect(resolveSignalSender({ sourceNumber: NUMBER, sourceUuid: null })).toEqual({
      kind: "phone",
      raw: NUMBER,
      e164: NUMBER,
    });
  });

  it("uuid-only envelope -> uuid sender without e164", () => {
    expect(resolveSignalSender({ sourceUuid: UUID })).toEqual({ kind: "uuid", raw: UUID });
  });

  it("lowercases the uuid so ids are stable", () => {
    expect(resolveSignalSender({ sourceUuid: UUID.toUpperCase() })).toEqual({
      kind: "uuid",
      raw: UUID,
    });
  });

  it("no identity -> null", () => {
    expect(resolveSignalSender({ sourceNumber: " ", sourceUuid: "" })).toBeNull();
  });
});

describe("labels and ids are uuid-first (§2.2/§2.3)", () => {
  const sender = resolveSignalSender({ sourceUuid: UUID, sourceNumber: NUMBER })!;

  it("sender id, display, peer id are uuid:<uuid>; recipient is the bare uuid", () => {
    expect(formatSignalSenderId(sender)).toBe(`uuid:${UUID}`);
    expect(formatSignalSenderDisplay(sender)).toBe(`uuid:${UUID}`);
    expect(resolveSignalPeerId(sender)).toBe(`uuid:${UUID}`);
    expect(resolveSignalRecipient(sender)).toBe(UUID);
  });

  it("pairing line never contains the number for a uuid sender", () => {
    const line = formatSignalPairingIdLine(sender);
    expect(line).toBe(`Your Signal sender id: uuid:${UUID}`);
    expect(line).not.toContain(NUMBER);
    expect(line).not.toContain(NUMBER.slice(1));
  });

  it("number-only senders still get the number line (no uuid known)", () => {
    const phone = resolveSignalSender({ sourceNumber: NUMBER })!;
    expect(formatSignalPairingIdLine(phone)).toBe(`Your Signal number: ${NUMBER}`);
  });
});

describe("isSignalSenderAllowed (§3.1/§3.2)", () => {
  const sender = resolveSignalSender({ sourceUuid: UUID, sourceNumber: NUMBER })!;

  it("a uuid entry admits the uuid sender without warning", () => {
    const warn = vi.fn();
    expect(isSignalSenderAllowed(sender, [`uuid:${UUID}`], { warn })).toBe(true);
    expect(isSignalSenderAllowed(sender, [UUID.toUpperCase()], { warn })).toBe(true);
    expect(isSignalSenderAllowed(sender, [`signal:uuid:${UUID}`], { warn })).toBe(true);
    expect(warn).not.toHaveBeenCalled();
  });

  it("a legacy phone entry still admits the uuid sender and warns once per (entry, account)", () => {
    const warn = vi.fn();
    expect(isSignalSenderAllowed(sender, [NUMBER], { accountId: "default", warn })).toBe(true);
    expect(isSignalSenderAllowed(sender, [NUMBER], { accountId: "default", warn })).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0]?.[0]);
    expect(message).toMatch(
      new RegExp(
        `^signal allowFrom entry \\+\\S+ matched uuid:${UUID} — replace it with the uuid$`,
      ),
    );
    // masked: the full number is never logged
    expect(message).not.toContain(NUMBER);
    // a different account warns again, once
    expect(isSignalSenderAllowed(sender, [NUMBER], { accountId: "work", warn })).toBe(true);
    expect(isSignalSenderAllowed(sender, [NUMBER], { accountId: "work", warn })).toBe(true);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("a uuid entry match does not warn even when a phone entry is also present", () => {
    const warn = vi.fn();
    expect(isSignalSenderAllowed(sender, [NUMBER, `uuid:${UUID}`], { warn })).toBe(true);
    expect(warn).not.toHaveBeenCalled();
  });

  it("mismatched entries deny", () => {
    const warn = vi.fn();
    expect(isSignalSenderAllowed(sender, [`uuid:${OTHER_UUID}`, OTHER_NUMBER], { warn })).toBe(
      false,
    );
    expect(isSignalSenderAllowed(sender, [], { warn })).toBe(false);
    // uuid-only sender: a phone entry cannot match (no secondary number)
    const uuidOnly = resolveSignalSender({ sourceUuid: UUID })!;
    expect(isSignalSenderAllowed(uuidOnly, [NUMBER], { warn })).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });

  it("wildcard unchanged", () => {
    expect(isSignalSenderAllowed(sender, ["*"])).toBe(true);
  });

  it("phone-only senders still match phone entries, without the legacy warning", () => {
    const warn = vi.fn();
    const phone = resolveSignalSender({ sourceNumber: NUMBER })!;
    expect(isSignalSenderAllowed(phone, [NUMBER], { warn })).toBe(true);
    expect(isSignalSenderAllowed(phone, [`uuid:${UUID}`], { warn })).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });

  it("never rewrites the allow list it is given", () => {
    const allowFrom = [NUMBER];
    isSignalSenderAllowed(sender, allowFrom, { warn: () => {} });
    expect(allowFrom).toEqual([NUMBER]);
  });
});

describe("allow-entry helpers", () => {
  it("masks numbers for logs", () => {
    expect(maskSignalNumber(NUMBER)).toBe("+15*******11");
    expect(maskSignalNumber(NUMBER)).not.toContain(NUMBER.slice(3, 9));
  });

  it("formats entries for shared matching without mangling uuids", () => {
    expect(formatSignalAllowEntryForMatch(`signal:${NUMBER}`)).toBe(NUMBER);
    expect(formatSignalAllowEntryForMatch(UUID.toUpperCase())).toBe(`uuid:${UUID}`);
    expect(formatSignalAllowEntryForMatch(`uuid:${UUID}`)).toBe(`uuid:${UUID}`);
    expect(formatSignalAllowEntryForMatch("*")).toBe("*");
  });

  it("write guard accepts uuids only (§3.3)", () => {
    expect(toSignalUuidAllowEntry(UUID)).toBe(`uuid:${UUID}`);
    expect(toSignalUuidAllowEntry(`uuid:${UUID.toUpperCase()}`)).toBe(`uuid:${UUID}`);
    expect(toSignalUuidAllowEntry(NUMBER)).toBeUndefined();
    expect(toSignalUuidAllowEntry("*")).toBeUndefined();
  });
});
