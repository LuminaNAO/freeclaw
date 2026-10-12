// Gateway crash log ARCH §4: a finished exec call must not leave its abort listener on the tool
// signal. With AbortSignal.any (pi-tools.abort.ts) a composite signal that still has an abort
// listener is held by Node for the life of the process, pinning the run state behind it.
import { afterEach, expect, test } from "vitest";
import { resetProcessRegistryForTests } from "./bash-process-registry.js";
import { createExecTool } from "./bash-tools.exec.js";

afterEach(() => {
  resetProcessRegistryForTests();
});

function trackAbortListeners(signal: AbortSignal) {
  const live = new Set<unknown>();
  const add = signal.addEventListener.bind(signal);
  const remove = signal.removeEventListener.bind(signal);
  signal.addEventListener = ((type: string, listener: unknown, opts?: unknown) => {
    if (type === "abort") {
      live.add(listener);
    }
    add(type as "abort", listener as EventListener, opts as AddEventListenerOptions);
  }) as AbortSignal["addEventListener"];
  signal.removeEventListener = ((type: string, listener: unknown, opts?: unknown) => {
    if (type === "abort") {
      live.delete(listener);
    }
    remove(type as "abort", listener as EventListener, opts as EventListenerOptions);
  }) as AbortSignal["removeEventListener"];
  return live;
}

test("exec removes its abort listener once the command finishes", async () => {
  const tool = createExecTool({ security: "full", ask: "off", host: "gateway" });
  const signal = AbortSignal.any([new AbortController().signal, new AbortController().signal]);
  const live = trackAbortListeners(signal);
  const result = await tool.execute("call-1", { command: "echo ok" }, signal);
  expect(result.details).toMatchObject({ status: "completed" });
  expect(live.size).toBe(0);
});

test("exec removes its abort listener when the command fails", async () => {
  const tool = createExecTool({ security: "full", ask: "off", host: "gateway" });
  const signal = AbortSignal.any([new AbortController().signal, new AbortController().signal]);
  const live = trackAbortListeners(signal);
  await tool.execute("call-2", { command: "exit 3" }, signal).catch(() => undefined);
  expect(live.size).toBe(0);
});
