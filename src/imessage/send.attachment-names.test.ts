import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTempHomeEnv, type TempHomeEnv } from "../test-utils/temp-home.js";
import type { ResolvedIMessageAccount } from "./accounts.js";
import type { IMessageRpcClient } from "./client.js";

// signal-attachment-names §3.7: iMessage uses the same resolver; the file it sends keeps its name.
const requestMock = vi.fn();

const account: ResolvedIMessageAccount = {
  accountId: "default",
  enabled: true,
  configured: false,
  config: {},
};

describe("sendMessageIMessage attachment names (signal-attachment-names §3.7)", () => {
  let tempHome: TempHomeEnv;
  let srcDir = "";
  let outboundDir = "";
  let sendMessageIMessage: typeof import("./send.js").sendMessageIMessage;

  beforeAll(async () => {
    tempHome = await createTempHomeEnv("openclaw-imessage-names-");
    srcDir = path.join(tempHome.home, "out");
    await fs.mkdir(srcDir, { recursive: true });
    ({ sendMessageIMessage } = await import("./send.js"));
    const { getMediaDir } = await import("../media/store.js");
    outboundDir = path.join(getMediaDir(), "outbound");
  });

  afterAll(async () => {
    await tempHome.restore();
  });

  it("passes media/outbound/<uuid>/<source name> as the file", async () => {
    requestMock.mockResolvedValue({ ok: true });
    const source = path.join(srcDir, "Holiday Plan.pdf");
    await fs.writeFile(source, "%PDF-1.4\nplan\n");

    await sendMessageIMessage("chat_id:7", "", {
      account,
      config: {},
      client: {
        request: (...args: unknown[]) => requestMock(...args),
        stop: async () => {},
      } as unknown as IMessageRpcClient,
      mediaUrl: source,
      mediaLocalRoots: [srcDir],
    });

    const params = requestMock.mock.lastCall?.[1] as Record<string, unknown>;
    const file = params.file as string;
    expect(path.basename(file)).toBe("Holiday Plan.pdf");
    expect(path.dirname(path.dirname(file))).toBe(outboundDir);
    expect(params.text).toBe("<media:document>");
  });
});
