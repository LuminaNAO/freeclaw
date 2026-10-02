import type { Command } from "commander";
import { loadConfig } from "../config/config.js";
import { normalizeAccountId } from "../routing/account-id.js";
import { defaultRuntime } from "../runtime.js";
import { resolveSignalAccount } from "../signal/accounts.js";
import { readSignalTrustAttempts } from "../signal/trust/attempts.js";
import { isSignalTrustGateEnforced, SIGNAL_TRUST_GATE_ENV } from "../signal/trust/gate.js";
import { canonicalizeTrustInput, type SignalTrustEntry } from "../signal/trust/identity.js";
import { readSignalTrustStoreForCli, updateSignalTrustStore } from "../signal/trust/store.js";
import { getTerminalTableWidth, renderTable } from "../terminal/table.js";
import { theme } from "../terminal/theme.js";

function resolveAccountOption(opts: { account?: unknown }): string {
  return normalizeAccountId(typeof opts.account === "string" ? opts.account : undefined);
}

function parseIdOrThrow(raw: string) {
  const parsed = canonicalizeTrustInput(raw);
  if (!parsed) {
    throw new Error(
      `Not a valid Signal sender id: expected E.164 (+15550000001) or a hyphenated uuid (optionally uuid:<id>).`,
    );
  }
  return parsed;
}

function formatEntry(entry: SignalTrustEntry): string {
  return [entry.number, entry.uuid ? `uuid:${entry.uuid}` : undefined].filter(Boolean).join(" ");
}

/**
 * Operator-only trust store writer. The trust store is never written by chat commands, agent
 * tools, pairing approval, or gateway RPC; this CLI and hand edits are the only writers.
 */
export function registerSignalTrustCli(program: Command) {
  const signal = program.command("signal").description("Signal channel operator tools");
  const trust = signal
    .command("trust")
    .description(
      `Manage the Signal ingress trust store (enforced when ${SIGNAL_TRUST_GATE_ENV}=enforce)`,
    );

  trust
    .command("add")
    .description("Trust a sender (number and/or uuid; pass both to bind them together)")
    .argument("<id>", "E.164 number or uuid")
    .argument("[id2]", "Optional second id (the other kind) to bind in the same entry")
    .option("--account <accountId>", "Signal account id", "default")
    .action(async (id: string, id2: string | undefined, opts) => {
      const accountId = resolveAccountOption(opts);
      const ids = [parseIdOrThrow(id), ...(id2 ? [parseIdOrThrow(id2)] : [])];
      const entry: SignalTrustEntry = { addedAt: new Date().toISOString() };
      for (const parsed of ids) {
        if (entry[parsed.kind] !== undefined) {
          throw new Error("Pass at most one number and one uuid.");
        }
        entry[parsed.kind] = parsed.value;
      }
      const result = await updateSignalTrustStore({
        accountId,
        mutate: (current) => {
          const clash = current.trusted.find(
            (existing) =>
              (entry.number !== undefined && existing.number === entry.number) ||
              (entry.uuid !== undefined && existing.uuid === entry.uuid),
          );
          if (clash) {
            if (
              (clash.number ?? null) === (entry.number ?? null) &&
              (clash.uuid ?? null) === (entry.uuid ?? null)
            ) {
              return null;
            }
            throw new Error(
              `An entry already covers this id (${formatEntry(clash)}). Remove it first to change its binding.`,
            );
          }
          return { ...current, trusted: [...current.trusted, entry] };
        },
      });
      defaultRuntime.log(
        result.changed
          ? `${theme.success("Trusted")} ${formatEntry(entry)} ${theme.muted(`(account=${accountId})`)}`
          : theme.muted(`Already trusted: ${formatEntry(entry)}`),
      );
    });

  trust
    .command("remove")
    .description("Revoke trust (removes every entry containing this id)")
    .argument("<id>", "E.164 number or uuid")
    .option("--account <accountId>", "Signal account id", "default")
    .action(async (id: string, opts) => {
      const accountId = resolveAccountOption(opts);
      const parsed = parseIdOrThrow(id);
      const result = await updateSignalTrustStore({
        accountId,
        mutate: (current) => {
          const next = current.trusted.filter((entry) => entry[parsed.kind] !== parsed.value);
          return next.length === current.trusted.length ? null : { ...current, trusted: next };
        },
      });
      defaultRuntime.log(
        result.changed
          ? `${theme.success("Revoked")} ${parsed.value} ${theme.muted(`(account=${accountId}; effective on next inbound event)`)}`
          : theme.muted(`Not in trust store: ${parsed.value}`),
      );
    });

  trust
    .command("list")
    .description("List trusted senders")
    .option("--account <accountId>", "Signal account id", "default")
    .option("--json", "Print JSON", false)
    .action(async (opts) => {
      const accountId = resolveAccountOption(opts);
      const { filePath, snapshot } = await readSignalTrustStoreForCli({ accountId });
      if (opts.json) {
        defaultRuntime.log(JSON.stringify({ accountId, filePath, ...snapshot }, null, 2));
        return;
      }
      if (!snapshot.ok) {
        defaultRuntime.error(theme.error(`Trust store unusable (${snapshot.error}): ${filePath}`));
        return;
      }
      if (snapshot.trusted.length === 0) {
        defaultRuntime.log(theme.muted(`No trusted senders (account=${accountId}).`));
        return;
      }
      defaultRuntime.log(
        renderTable({
          width: getTerminalTableWidth(),
          columns: [
            { key: "Number", header: "Number", minWidth: 14 },
            { key: "Uuid", header: "Uuid", minWidth: 36, flex: true },
            { key: "Added", header: "Added", minWidth: 12 },
          ],
          rows: snapshot.trusted.map((entry) => ({
            Number: entry.number ?? "",
            Uuid: entry.uuid ?? "",
            Added: entry.addedAt ?? "",
          })),
        }).trimEnd(),
      );
    });

  trust
    .command("import-allowfrom")
    .description(
      "One-shot copy of canonical channels.signal allowFrom entries into the trust store",
    )
    .option("--account <accountId>", "Signal account id", "default")
    .action(async (opts) => {
      const accountId = resolveAccountOption(opts);
      const account = resolveSignalAccount({ cfg: loadConfig(), accountId });
      const skipped: string[] = [];
      const additions: SignalTrustEntry[] = [];
      for (const raw of account.config.allowFrom ?? []) {
        const value = String(raw).trim();
        const parsed = value === "*" ? null : canonicalizeTrustInput(value);
        if (!parsed) {
          skipped.push(
            value === "*" ? '"*" (wildcards are never imported)' : "<non-canonical entry>",
          );
          continue;
        }
        additions.push({ [parsed.kind]: parsed.value, addedAt: new Date().toISOString() });
      }
      const result = await updateSignalTrustStore({
        accountId,
        mutate: (current) => {
          const trusted = [...current.trusted];
          for (const entry of additions) {
            const covered = trusted.some(
              (existing) =>
                (entry.number !== undefined && existing.number === entry.number) ||
                (entry.uuid !== undefined && existing.uuid === entry.uuid),
            );
            if (!covered) {
              trusted.push(entry);
            }
          }
          return trusted.length === current.trusted.length ? null : { ...current, trusted };
        },
      });
      defaultRuntime.log(
        `${theme.success("Imported")} ${result.store.trusted.length} trusted sender(s) ${theme.muted(`(account=${accountId})`)}`,
      );
      for (const item of skipped) {
        defaultRuntime.log(theme.warn(`Skipped ${item}`));
      }
    });

  trust
    .command("attempts")
    .description("Show flagged denied ingress attempts")
    .option("--account <accountId>", "Signal account id")
    .option("--limit <n>", "Maximum records", "50")
    .option("--json", "Print JSON", false)
    .action(async (opts) => {
      const records = await readSignalTrustAttempts({
        accountId: typeof opts.account === "string" ? normalizeAccountId(opts.account) : undefined,
        limit: Math.max(1, Number.parseInt(String(opts.limit), 10) || 50),
      });
      if (opts.json) {
        defaultRuntime.log(JSON.stringify(records, null, 2));
        return;
      }
      if (records.length === 0) {
        defaultRuntime.log(theme.muted("No flagged attempts."));
        return;
      }
      defaultRuntime.log(
        renderTable({
          width: getTerminalTableWidth(),
          columns: [
            { key: "Time", header: "Time", minWidth: 20 },
            { key: "Account", header: "Account", minWidth: 8 },
            { key: "Sender", header: "Sender", minWidth: 14, flex: true },
            { key: "Reason", header: "Reason", minWidth: 12 },
            { key: "Kind", header: "Kind", minWidth: 6 },
            { key: "Count", header: "Count", minWidth: 5 },
          ],
          rows: records.map((record) => ({
            Time: record.ts,
            Account: record.accountId,
            Sender: [record.number, record.uuid ? `uuid:${record.uuid}` : null]
              .filter(Boolean)
              .join(" "),
            Reason: record.reason,
            Kind: record.kind,
            Count: String(record.count),
          })),
        }).trimEnd(),
      );
    });

  trust
    .command("status")
    .description("Show whether the gate is enforcing and whether the store is valid")
    .option("--account <accountId>", "Signal account id", "default")
    .action(async (opts) => {
      const accountId = resolveAccountOption(opts);
      const { filePath, snapshot } = await readSignalTrustStoreForCli({ accountId });
      const enforced = isSignalTrustGateEnforced();
      defaultRuntime.log(
        `gate: ${enforced ? "enforce" : `off (set ${SIGNAL_TRUST_GATE_ENV}=enforce in the gateway service environment)`}`,
      );
      defaultRuntime.log(`store: ${filePath}`);
      defaultRuntime.log(
        snapshot.ok
          ? `store state: valid, ${snapshot.trusted.length} trusted sender(s)`
          : `store state: INVALID (${snapshot.error}) - all senders denied while enforcing`,
      );
    });
}
