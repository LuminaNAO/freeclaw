import { renderTable } from "../terminal/table.js";
import { formatTokenCount } from "../utils/usage-format.js";
import {
  type UsageReport,
  type UsageTotals,
  USAGE_TIMEFRAMES,
  totalTokens,
} from "./usage-stats.js";

const TREE_BRANCH = "└";

/** Local GGUF names run long; cap the column so rows stay one line. */
const SCOPE_MAX_WIDTH = 46;

const TIMEFRAME_LABEL: Record<string, string> = {
  "1h": "last hour",
  "24h": "last 24 hours",
  "7d": "last 7 days",
  "30d": "last 30 days",
  all: "all time",
};

export function formatTimeframeLabel(timeframe: string): string {
  return TIMEFRAME_LABEL[timeframe] ?? timeframe;
}

export function usageTimeframeHint(): string {
  return `timeframes: ${USAGE_TIMEFRAMES.join(" | ")}`;
}

/** Middle-truncate so both the family prefix and the quant suffix stay visible. */
function truncateScope(text: string, max: number): string {
  if (text.length <= max) {
    return text;
  }
  const keepEnd = Math.max(8, Math.floor((max - 1) / 2));
  const keepStart = max - 1 - keepEnd;
  return `${text.slice(0, keepStart)}…${text.slice(text.length - keepEnd)}`;
}

function cacheCell(totals: UsageTotals): string {
  if (totals.cacheRead === 0 && totals.cacheWrite === 0) {
    return "-";
  }
  return `${formatTokenCount(totals.cacheRead)}/${formatTokenCount(totals.cacheWrite)}`;
}

/**
 * Render the report as an agent-grouped table: one row per agent, then an
 * indented row per model, then a grand total.
 */
export function renderUsageReport(report: UsageReport, options: { width?: number } = {}): string {
  const header = `Usage — ${formatTimeframeLabel(report.timeframe)}`;
  if (report.agents.length === 0) {
    const note =
      report.skippedUndated > 0
        ? "No timestamped usage in this window."
        : "No recorded usage found.";
    return `${header}\n${note}\n`;
  }

  const rows: Array<Record<string, string>> = [];
  for (const agent of report.agents) {
    rows.push({
      scope: `${agent.agentId}  (${agent.models.length} model${
        agent.models.length === 1 ? "" : "s"
      })`,
      input: formatTokenCount(agent.input),
      output: formatTokenCount(agent.output),
      cache: cacheCell(agent),
      turns: String(agent.turns),
      total: formatTokenCount(totalTokens(agent)),
    });
    for (const model of agent.models) {
      rows.push({
        scope: `  ${TREE_BRANCH} ${truncateScope(model.key, SCOPE_MAX_WIDTH - 4)}`,
        input: formatTokenCount(model.input),
        output: formatTokenCount(model.output),
        cache: cacheCell(model),
        turns: String(model.turns),
        total: formatTokenCount(totalTokens(model)),
      });
    }
  }
  if (report.agents.length > 1) {
    rows.push({
      scope: "TOTAL",
      input: formatTokenCount(report.totals.input),
      output: formatTokenCount(report.totals.output),
      cache: cacheCell(report.totals),
      turns: String(report.totals.turns),
      total: formatTokenCount(totalTokens(report.totals)),
    });
  }

  const table = renderTable({
    columns: [
      { key: "scope", header: "agent / model", maxWidth: SCOPE_MAX_WIDTH },
      { key: "input", header: "input", align: "right" },
      { key: "output", header: "output", align: "right" },
      { key: "cache", header: "cache r/w", align: "right" },
      { key: "turns", header: "turns", align: "right" },
      { key: "total", header: "total", align: "right" },
    ],
    rows,
    width: options.width,
  });

  const footer =
    report.skippedUndated > 0
      ? `\n${report.skippedUndated} turn(s) without timestamps excluded from this window.\n`
      : "";
  return `${header}\n${table}${footer}`;
}
