import { describe, expect, it } from "vitest";
import {
  canonicalizeTrustInput,
  decideSignalTrust,
  formatIdentityForLog,
  parseEnvelopeIdentity,
  parseEnvelopeNumber,
  parseEnvelopeUuid,
  type SignalTrustEntry,
} from "./identity.js";

const NUM_A = "+15550000001";
const NUM_B = "+15550000002";
const UUID_A = "00000000-0000-4000-8000-00000000000a";
const UUID_B = "00000000-0000-4000-8000-00000000000b";

function decide(
  envelope: { sourceNumber?: unknown; sourceUuid?: unknown },
  trusted: SignalTrustEntry[],
) {
  return decideSignalTrust(parseEnvelopeIdentity(envelope), trusted);
}

describe("strict number canonicalization", () => {
  it.each([NUM_A, "+4915550000001", " +15550000001 "])("accepts %j", (value) => {
    expect(parseEnvelopeNumber(value)).toEqual({ state: "valid", value: value.trim() });
  });

  it.each([
    "+1 (555) 000-0001",
    "15550000001",
    "+",
    "+0123456789",
    "+123456",
    "+1234567890123456",
    "abc",
    "+1555000\u00000001",
    "+15550000001\n",
    "signal:+15550000001",
  ])("never coerces %j (malformed)", (value) => {
    const parsed = parseEnvelopeNumber(value);
    if (value === "+15550000001\n") {
      // trailing whitespace is trimmed like any other envelope whitespace
      expect(parsed.state).toBe("valid");
      return;
    }
    expect(parsed.state).toBe("malformed");
  });

  it("treats null/empty as absent", () => {
    expect(parseEnvelopeNumber(null).state).toBe("absent");
    expect(parseEnvelopeNumber("  ").state).toBe("absent");
  });
});

describe("strict uuid canonicalization", () => {
  it("lowercases hyphenated uuids of any case", () => {
    expect(parseEnvelopeUuid(UUID_A.toUpperCase())).toEqual({ state: "valid", value: UUID_A });
  });

  it.each([UUID_A.replace(/-/g, ""), `uuid:${UUID_A}`, `${UUID_A}x`, "not-a-uuid"])(
    "rejects %j as malformed",
    (value) => {
      expect(parseEnvelopeUuid(value).state).toBe("malformed");
    },
  );
});

describe("operator input canonicalization (CLI)", () => {
  it("accepts signal:/uuid: prefixes and uppercase uuids", () => {
    expect(canonicalizeTrustInput(`signal:${NUM_A}`)).toEqual({ kind: "number", value: NUM_A });
    expect(canonicalizeTrustInput(`uuid:${UUID_A.toUpperCase()}`)).toEqual({
      kind: "uuid",
      value: UUID_A,
    });
    expect(canonicalizeTrustInput(`signal:uuid:${UUID_A}`)).toEqual({
      kind: "uuid",
      value: UUID_A,
    });
  });

  it("still rejects formatted numbers, wildcards, and compact uuids", () => {
    expect(canonicalizeTrustInput("+1 555 000 0001")).toBeNull();
    expect(canonicalizeTrustInput("*")).toBeNull();
    expect(canonicalizeTrustInput(UUID_A.replace(/-/g, ""))).toBeNull();
  });
});

describe("decision rule (ARCH §4.3)", () => {
  it("denies with no_identity when neither field is present (not flagged)", () => {
    expect(decide({}, [{ number: NUM_A }])).toEqual({
      allow: false,
      reason: "no_identity",
      flag: false,
    });
  });

  it("denies malformed_identity even when the other field is valid and trusted", () => {
    expect(decide({ sourceNumber: "garbage", sourceUuid: UUID_A }, [{ uuid: UUID_A }])).toEqual({
      allow: false,
      reason: "malformed_identity",
      flag: true,
    });
  });

  it("denies identity_conflict when the number matches but the uuid differs", () => {
    const trusted = [{ number: NUM_A, uuid: UUID_A }];
    expect(decide({ sourceNumber: NUM_A, sourceUuid: UUID_B }, trusted)).toMatchObject({
      allow: false,
      reason: "identity_conflict",
    });
  });

  it("denies identity_conflict when the uuid matches but the number differs", () => {
    const trusted = [{ number: NUM_A, uuid: UUID_A }];
    expect(decide({ sourceNumber: NUM_B, sourceUuid: UUID_A }, trusted)).toMatchObject({
      allow: false,
      reason: "identity_conflict",
    });
  });

  it("a conflict on one entry is not rescued by a clean match on another", () => {
    const trusted = [{ number: NUM_A, uuid: UUID_A }, { uuid: UUID_B }];
    expect(decide({ sourceNumber: NUM_A, sourceUuid: UUID_B }, trusted)).toMatchObject({
      reason: "identity_conflict",
    });
  });

  it("allows a bound pair when both fields match", () => {
    expect(
      decide({ sourceNumber: NUM_A, sourceUuid: UUID_A }, [{ number: NUM_A, uuid: UUID_A }]),
    ).toEqual({ allow: true, number: NUM_A, uuid: UUID_A });
  });

  it("number-only entry trusts that number with any uuid, and uuid-only with any number", () => {
    expect(decide({ sourceNumber: NUM_A, sourceUuid: UUID_B }, [{ number: NUM_A }]).allow).toBe(
      true,
    );
    expect(decide({ sourceNumber: NUM_B, sourceUuid: UUID_A }, [{ uuid: UUID_A }]).allow).toBe(
      true,
    );
    expect(decide({ sourceUuid: UUID_A }, [{ uuid: UUID_A }]).allow).toBe(true);
  });

  it("matches an uppercase envelope uuid against the canonical lowercase entry", () => {
    expect(decide({ sourceUuid: UUID_A.toUpperCase() }, [{ uuid: UUID_A }]).allow).toBe(true);
  });

  it("does not match across kinds and denies not_trusted", () => {
    expect(decide({ sourceNumber: NUM_B }, [{ number: NUM_A }, { uuid: UUID_A }])).toEqual({
      allow: false,
      reason: "not_trusted",
      flag: true,
    });
    expect(decide({ sourceUuid: UUID_B }, [{ number: NUM_A }]).allow).toBe(false);
  });

  it("an empty trust list denies everyone", () => {
    expect(decide({ sourceNumber: NUM_A }, []).allow).toBe(false);
  });
});

describe("log formatting", () => {
  it("never renders a malformed raw value, only its length and hash prefix", () => {
    const rendered = formatIdentityForLog(
      parseEnvelopeIdentity({ sourceNumber: "+1555\u001b[31mEVIL\nline" }),
    );
    expect(rendered).toMatch(/^malformed\(len=\d+,sha256=[0-9a-f]{8}\)$/);
    expect(rendered).not.toContain("EVIL");
  });

  it("renders canonical identities verbatim", () => {
    expect(
      formatIdentityForLog(parseEnvelopeIdentity({ sourceNumber: NUM_A, sourceUuid: UUID_A })),
    ).toBe(`${NUM_A},uuid:${UUID_A}`);
  });
});
