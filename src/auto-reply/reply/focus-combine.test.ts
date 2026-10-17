import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { FOCUS_COMBINED_HEADER } from "../../infra/focus-mode.js";
import { buildFocusCombinedContext, buildFocusCombinedPrompt } from "./focus-combine.js";

const cfg = { agents: { defaults: { userTimezone: "UTC" } } } as OpenClawConfig;
const t0 = Date.UTC(2026, 9, 17, 10, 0, 0);

describe("focus mode combined prompt (focus-mode ARCH §5.2)", () => {
  it("messages in arrival order, each with sender and time, under the header", () => {
    const prompt = buildFocusCombinedPrompt(
      [
        { ctx: { SenderName: "Ann", Body: "one", Timestamp: t0 }, arrivalMs: 0 },
        { ctx: { SenderUsername: "bob", BodyForAgent: "two" }, arrivalMs: t0 + 60_000 },
        { ctx: { SenderId: "+1555", RawBody: "three", Timestamp: t0 + 120_000 }, arrivalMs: 0 },
      ],
      cfg,
    );
    expect(prompt).toBe(
      [
        FOCUS_COMBINED_HEADER,
        "[Ann, 2026-10-17 10:00 UTC] one",
        "[bob, 2026-10-17 10:01 UTC] two",
        "[+1555, 2026-10-17 10:02 UTC] three",
      ].join("\n"),
    );
  });

  it("newest ctx carries the route; media merged; images kept", () => {
    const { ctx, images } = buildFocusCombinedContext(
      [
        {
          ctx: { Body: "a", OriginatingTo: "x", MediaUrl: "u1", MediaType: "image/png" },
          images: [{ type: "image", data: "AA", mimeType: "image/png" }],
          arrivalMs: t0,
        },
        { ctx: { Body: "b", OriginatingTo: "y", ThreadLabel: "t" }, arrivalMs: t0 + 1 },
      ],
      cfg,
    );
    expect(ctx.OriginatingTo).toBe("y");
    expect(ctx.ThreadLabel).toBe("t");
    expect(ctx.MediaUrls).toEqual(["u1"]);
    expect(ctx.MediaPaths).toEqual(["u1"]);
    expect(ctx.MediaTypes).toEqual(["image/png"]);
    expect(ctx.MediaType).toBe("image/png");
    expect(images).toHaveLength(1);
  });

  it("no media → no media fields", () => {
    const { ctx, images } = buildFocusCombinedContext([{ ctx: { Body: "a" }, arrivalMs: t0 }], cfg);
    expect(ctx.MediaPaths).toBeUndefined();
    expect(ctx.MediaType).toBeUndefined();
    expect(images).toBeUndefined();
  });
});
