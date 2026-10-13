/**
 * Tool-call argument integrity (docs/design/toolcall-argument-integrity.md).
 *
 * Source code carried in tool-call arguments (exec command, write content, edit
 * newText) must reach the tool byte-for-byte when it arrives over a streamed
 * openai-completions response, however the provider splits the argument deltas.
 * Redaction is a log/display concern and must never alter those arguments.
 */
import { streamOpenAICompletions, type Model } from "@mariozechner/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { redactSensitiveText, redactToolDetail } from "../logging/redact.js";
import { wrapStreamFnTrimToolCallNames } from "./pi-embedded-runner/run/attempt.js";
import { sanitizeToolCallInputs } from "./session-transcript-repair.js";

const NL = "\n";
const BS = "\\";

/** Multiline sources that exercise the reported failure shape and its neighbours. */
const SOURCES: Record<string, string> = {
  blockOpeners: [
    "def summarise(c, b):",
    "    for x in c:",
    "        t = x.get('type')",
    "        if not b:",
    "            break",
    "    is_zero = len(c) == 0",
    "    while True:",
    "        try:",
    "            pass",
    "        except Exception:",
    "            raise",
    "    return {'k': is_zero}",
    "",
  ].join(NL),
  // Single-letter identifier right before the colon: the exact trigger shape.
  singleLetterBeforeColon: [
    "for p in c:",
    "    t = p",
    "if d:",
    "    pass",
    "x = {'a': b}",
    "",
  ].join(NL),
  escapedLiterals: [
    `msg = "line1${BS}nline2"`,
    `path = "C:${BS}${BS}new${BS}${BS}temp"`,
    `raw = r"${BS}n stays ${BS}t raw"`,
    `tab = 'a${BS}tb'`,
    `quote = "say ${BS}"hi${BS}""`,
    `uni = "${BS}u00e9"`,
    "",
  ].join(NL),
  heredoc: [
    "python3 - <<'PY'",
    "import json, sys",
    "for line in sys.stdin:",
    "    if not line.strip():",
    "        continue",
    `    print(json.dumps(line) + "${BS}n")`,
    "PY",
    "cat <<EOF > /tmp/x.txt",
    "a: 1",
    "b:",
    "  - c",
    "EOF",
    "",
  ].join(NL),
  windowsPathThenCode: [`p = "C:${BS}${BS}tmp"`, "if p:", "    print(p)", ""].join(NL),
};

type ToolCase = { tool: string; args: Record<string, string> };

function toolCases(): ToolCase[] {
  const out: ToolCase[] = [];
  for (const [name, src] of Object.entries(SOURCES)) {
    out.push({ tool: "exec", args: { command: src } });
    out.push({ tool: "write", args: { path: `/tmp/${name}.py`, content: src } });
    out.push({
      tool: "edit",
      args: { path: `/tmp/${name}.py`, oldText: "pass", newText: src },
    });
  }
  return out;
}

/** Split strategies that put delta boundaries at the awkward places. */
const SPLITTERS: Record<string, (s: string) => string[]> = {
  whole: (s) => [s],
  oneChar: (s) => s.split(""),
  // Break right after every backslash, i.e. between "\" and "n".
  insideEscape: (s) => {
    const out: string[] = [];
    let cur = "";
    for (const ch of s) {
      cur += ch;
      if (ch === BS) {
        out.push(cur);
        cur = "";
      }
    }
    if (cur) {
      out.push(cur);
    }
    return out;
  },
  // Break right after ":" and right after every complete "\n" escape.
  afterColonAndEscapedNewline: (s) => {
    const out: string[] = [];
    let cur = "";
    for (let i = 0; i < s.length; i += 1) {
      cur += s[i];
      if (s[i] === ":" || (s[i] === "n" && s[i - 1] === BS)) {
        out.push(cur);
        cur = "";
      }
    }
    if (cur) {
      out.push(cur);
    }
    return out;
  },
  // Deterministic pseudo-random splits of 1..7 chars.
  ragged: (s) => {
    const out: string[] = [];
    let seed = 7;
    for (let i = 0; i < s.length; ) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      const n = 1 + (seed % 7);
      out.push(s.slice(i, i + n));
      i += n;
    }
    return out;
  },
};

function sseBody(toolName: string, deltas: string[]): string {
  const chunks: unknown[] = [
    {
      id: "c1",
      object: "chat.completion.chunk",
      choices: [
        {
          index: 0,
          delta: {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: "call_1",
                type: "function",
                function: { name: toolName, arguments: "" },
              },
            ],
          },
        },
      ],
    },
    ...deltas.map((d) => ({
      id: "c1",
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: d } }] } }],
    })),
    {
      id: "c1",
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
    },
  ];
  return `${chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("")}data: [DONE]\n\n`;
}

/** Serve the SSE body in 5-byte network chunks so SSE framing splits are adversarial too. */
function stubFetch(body: string) {
  const bytes = new TextEncoder().encode(body);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          for (let i = 0; i < bytes.length; i += 5) {
            controller.enqueue(bytes.slice(i, i + 5));
          }
          controller.close();
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }),
  );
}

const MODEL = {
  id: "fake-model",
  name: "fake",
  api: "openai-completions",
  provider: "fake-local",
  baseUrl: "http://fake.invalid/v1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 100_000,
  maxTokens: 1000,
} as unknown as Model<"openai-completions">;

const CONTEXT = { messages: [{ role: "user" as const, content: "go", timestamp: 0 }], tools: [] };

/**
 * Run the same chain freeclaw runs for openai-completions: pi-ai's streamer,
 * wrapped by the tool-name trim wrapper (the only argument-touching wrapper that
 * is active for openai-completions providers), then the transcript guard sanitize.
 */
async function streamToolCall(toolName: string, deltas: string[]) {
  stubFetch(sseBody(toolName, deltas));
  const streamFn = wrapStreamFnTrimToolCallNames(
    streamOpenAICompletions as never,
    new Set(["exec", "write", "edit"]),
  );
  const stream = (await streamFn(
    MODEL as never,
    CONTEXT as never,
    { apiKey: "test" } as never,
  )) as unknown as {
    [Symbol.asyncIterator](): AsyncIterator<{ type: string; toolCall?: { arguments: unknown } }>;
    result(): Promise<{
      stopReason: string;
      errorMessage?: string;
      content: Array<Record<string, unknown>>;
    }>;
  };
  let endArgs: unknown;
  for await (const event of stream) {
    if (event.type === "toolcall_end") {
      endArgs = structuredClone(event.toolCall?.arguments);
    }
  }
  const message = await stream.result();
  const [persisted] = sanitizeToolCallInputs([message as never], {
    allowedToolNames: ["exec", "write", "edit"],
  }) as unknown as Array<{ content: Array<Record<string, unknown>> }>;
  return { message, endArgs, persisted };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("tool-call argument integrity: streamed openai-completions", () => {
  for (const { tool, args } of toolCases()) {
    const wire = JSON.stringify(args);
    const label = `${tool} ${Object.keys(args).at(-1)} (${Object.values(args).at(-1)?.slice(0, 18)}…)`;
    for (const [splitName, split] of Object.entries(SPLITTERS)) {
      it(`${label} round-trips with ${splitName} deltas`, async () => {
        const deltas = split(wire);
        expect(deltas.join("")).toBe(wire);
        const { message, endArgs, persisted } = await streamToolCall(tool, deltas);
        expect(message.stopReason).toBe("toolUse");
        const block = message.content.find((b) => b.type === "toolCall");
        expect(block?.name).toBe(tool);
        // Byte-for-byte: compare the serialized form, not just deep equality.
        expect(JSON.stringify(block?.arguments)).toBe(wire);
        expect(JSON.stringify(endArgs)).toBe(wire);
        const persistedBlock = persisted.content.find((b) => b.type === "toolCall");
        expect(JSON.stringify(persistedBlock?.arguments)).toBe(wire);
        for (const value of Object.values(block?.arguments as Record<string, string>)) {
          // The reported corruption: a literal backslash-n right after a block opener.
          if (!Object.values(args).some((v) => v.includes(`:${BS}n`))) {
            expect(value).not.toMatch(/:\\n/);
          }
        }
      });
    }
  }
});

/**
 * The faulty parser lives in the provider proxy (cloudburst's bundled
 * @openclaw/ai json-parse), not in this repo. This mirrors its exact behaviour so
 * the transcript signature can be recognised, and pins that the parser freeclaw
 * uses (JSON.parse first, partial-json only for incomplete input) does not have it.
 */
describe("tool-call argument integrity: transcript signature of the upstream fault", () => {
  // Faithful reduction of repairJson's Windows-path branch in @openclaw/ai 2026.7.1-2:
  // a valid "\n" escape is doubled when the decoded text before it ends in "<letter>:".
  function upstreamRepairJson(json: string): string {
    let out = "";
    let inString = false;
    let prefix = "";
    for (let i = 0; i < json.length; i += 1) {
      const ch = json[i];
      if (!inString) {
        out += ch;
        if (ch === '"') {
          inString = true;
          prefix = "";
        }
        continue;
      }
      if (ch === '"') {
        out += ch;
        inString = false;
        continue;
      }
      if (ch === BS) {
        const next = json[i + 1];
        if (
          next &&
          "bfnrt".includes(next) &&
          /(?:^|[^A-Za-z0-9])[A-Za-z]:(?:[\\/][^"\\/:*?<>|\r\n]*)*$/.test(prefix.slice(-160))
        ) {
          out += BS + BS;
          prefix += BS;
          continue;
        }
        out += ch + (next ?? "");
        prefix += next === BS ? BS : BS + (next ?? "");
        i += 1;
        continue;
      }
      out += ch;
      prefix += ch;
    }
    return out;
  }

  it("valid JSON with 'c:' + newline is rewritten by the upstream repair, never by ours", async () => {
    const src = SOURCES.singleLetterBeforeColon;
    const wire = JSON.stringify({ command: src });
    const upstream = JSON.parse(upstreamRepairJson(wire)) as { command: string };
    expect(upstream.command).not.toBe(src);
    expect(upstream.command.startsWith(`for p in c:${BS}n    t = p`)).toBe(true);

    const { message } = await streamToolCall("exec", SPLITTERS.oneChar(wire));
    const block = message.content.find((b) => b.type === "toolCall");
    expect((block?.arguments as { command?: string } | undefined)?.command).toBe(src);
  });
});

describe("tool-call argument integrity: redaction", () => {
  const OPTS = { mode: "tools" as const };

  it("never alters source code that carries no secrets", () => {
    for (const src of Object.values(SOURCES)) {
      expect(redactSensitiveText(src, OPTS)).toBe(src);
      const wire = JSON.stringify({ command: src });
      expect(redactSensitiveText(wire, OPTS)).toBe(wire);
    }
  });

  it("still masks a real secret shape in log/display text", () => {
    const secret = `sk-${"a1B2c3D4e5".repeat(3)}`;
    const line = `curl -H "Authorization: Bearer ${secret}" https://example.invalid`;
    const redacted = redactSensitiveText(line, OPTS);
    expect(redacted).not.toContain(secret);
    expect(redactToolDetail(line)).not.toContain(secret);
  });

  it("does not mask secrets in tool arguments on their way to the tool", async () => {
    const secret = `sk-${"a1B2c3D4e5".repeat(3)}`;
    const src = [`API_KEY = "${secret}"`, "if API_KEY:", "    print('ok')", ""].join(NL);
    const wire = JSON.stringify({ command: src });
    const { message, endArgs, persisted } = await streamToolCall("exec", SPLITTERS.ragged(wire));
    const block = message.content.find((b) => b.type === "toolCall");
    expect((block?.arguments as { command?: string } | undefined)?.command).toBe(src);
    expect((endArgs as { command: string }).command).toBe(src);
    const persistedBlock = persisted.content.find((b) => b.type === "toolCall");
    expect((persistedBlock?.arguments as { command?: string } | undefined)?.command).toBe(src);
  });
});
