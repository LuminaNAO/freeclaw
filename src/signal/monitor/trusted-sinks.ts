import {
  recordPendingHistoryEntryIfEnabled,
  type HistoryEntry,
} from "../../auto-reply/reply/history.js";
import { enqueueSystemEvent } from "../../infra/system-events.js";
import type { SignalTrustedSender, SignalTrustGate } from "../trust/gate.js";

/**
 * Agent-visible sinks reachable before dispatch. Each requires a gate-minted
 * SignalTrustedSender and re-checks it against the current trust store, so a new code path that
 * skips the gate fails to compile, and a revocation between gate and sink still drops.
 */
export async function enqueueTrustedSignalSystemEvent(params: {
  gate: SignalTrustGate;
  trusted: SignalTrustedSender;
  groupId?: string;
  text: string;
  options: Parameters<typeof enqueueSystemEvent>[1];
}): Promise<boolean> {
  if (!(await params.gate.recheck(params.trusted, { kind: "reaction", groupId: params.groupId }))) {
    return false;
  }
  enqueueSystemEvent(params.text, params.options);
  return true;
}

export async function recordTrustedSignalPendingHistory(params: {
  gate: SignalTrustGate;
  trusted: SignalTrustedSender;
  historyMap: Map<string, HistoryEntry[]>;
  historyKey: string;
  limit: number;
  entry: HistoryEntry;
}): Promise<boolean> {
  if (!(await params.gate.recheck(params.trusted, { kind: "group", groupId: params.historyKey }))) {
    return false;
  }
  recordPendingHistoryEntryIfEnabled({
    historyMap: params.historyMap,
    historyKey: params.historyKey,
    limit: params.limit,
    entry: params.entry,
  });
  return true;
}
