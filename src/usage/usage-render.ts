import { renderTable, type TableColumn } from "../terminal/table.js";
import { formatTokenCount, formatUsd } from "../utils/usage-format.js";
import {
  type AgentUsageDetail,
  type ModelUsage,
  type UsageReport,
  type UsageTotals,
  USAGE_TIMEFRAMES,
  totalTokens,
} from "./usage-stats.js";

const TREE_BRANCH = "└";

/** Local GGUF names run long; cap the column so rows stay one line. */
const SCOPE_MAX_WIDTH = 46;

/**
 * Width consumed by the five numeric columns plus borders and padding. Used to
 * work out how much room a text column actually gets, so truncation matches the
 * width `renderTable` will settle on and rows never wrap. The cost column adds
 * a further ~10 when it is shown.
 */
const NUMERIC_COLUMNS_WIDTH = 54;
const COST_COLUMN_WIDTH = 10;

/** Never shrink a text column below this; below it the label is useless anyway. */
const MIN_TEXT_WIDTH = 18;

/** `YYYY-MM-DD` plus padding. */
const DAY_COLUMN_WIDTH = 12;

/** Room available to a single text column at the given total table width. */
function textColumnWidth(
  totalWidth: number | undefined,
  cap: number,
  numericWidth = NUMERIC_COLUMNS_WIDTH,
): number {
  if (!totalWidth || !Number.isFinite(totalWidth)) {
    return cap;
  }
  return Math.max(MIN_TEXT_WIDTH, Math.min(cap, totalWidth - numericWidth));
}

/**
 * `renderTable` reserves `padding` on each side, so text must be truncated to
 * the column width minus that padding or the remainder wraps to a second line.
 */
const CELL_PADDING = 2;

function fitCell(text: string, columnWidth: number): string {
  return truncateScope(text, Math.max(1, columnWidth - CELL_PADDING));
}

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

function costCell(totals: UsageTotals): string {
  return formatUsd(totals.cost) ?? "-";
}

function hasPricedCost(totals: UsageTotals, nested?: Array<{ cost?: number }>): boolean {
  if (totals.cost !== undefined) {
    return true;
  }
  return nested?.some((item) => item.cost !== undefined) ?? false;
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

  const showCost = hasPricedCost(report.totals, report.agents);
  const numericWidth = NUMERIC_COLUMNS_WIDTH + (showCost ? COST_COLUMN_WIDTH : 0);
  const scopeWidth = textColumnWidth(options.width, SCOPE_MAX_WIDTH, numericWidth);
  const rows: Array<Record<string, string>> = [];
  for (const agent of report.agents) {
    rows.push(
      totalsRow(
        `${agent.agentId}  (${agent.models.length} model${agent.models.length === 1 ? "" : "s"})`,
        agent,
        showCost,
      ),
    );
    for (const model of agent.models) {
      rows.push(
        totalsRow(
          `  ${TREE_BRANCH} ${truncateScope(model.key, scopeWidth - CELL_PADDING - 4)}`,
          model,
          showCost,
        ),
      );
    }
  }
  if (report.agents.length > 1) {
    rows.push(totalsRow("TOTAL", report.totals, showCost));
  }

  const table = renderTable({
    columns: [
      { key: "scope", header: "agent / model", maxWidth: scopeWidth },
      ...usageColumns(showCost),
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

function totalsRow(scope: string, totals: UsageTotals, showCost = false): Record<string, string> {
  const row: Record<string, string> = {
    scope,
    input: formatTokenCount(totals.input),
    output: formatTokenCount(totals.output),
    cache: cacheCell(totals),
    turns: String(totals.turns),
    total: formatTokenCount(totalTokens(totals)),
  };
  if (showCost) {
    row.cost = costCell(totals);
  }
  return row;
}

function usageColumns(showCost: boolean): TableColumn[] {
  const columns: TableColumn[] = [
    { key: "input", header: "input", align: "right" },
    { key: "output", header: "output", align: "right" },
    { key: "cache", header: "cache r/w", align: "right" },
    { key: "turns", header: "turns", align: "right" },
    { key: "total", header: "total", align: "right" },
  ];
  if (showCost) {
    columns.push({ key: "cost", header: "cost", align: "right" });
  }
  return columns;
}

/** Comma-joined model keys for a day row, truncated to keep the column narrow. */
function summarizeDayModels(models: ModelUsage[], max: number): string {
  if (models.length === 0) {
    return "-";
  }
  const joined = models.map((model) => model.key).join(", ");
  return truncateScope(joined, max);
}

/**
 * Render one agent in detail: a per-model rollup for the whole window, then a
 * per-day table showing where the tokens went.
 */
export function renderAgentUsageDetail(
  detail: AgentUsageDetail,
  options: { width?: number } = {},
): string {
  const header = `Usage — ${detail.agentId} — ${formatTimeframeLabel(detail.timeframe)}`;
  if (detail.totals.turns === 0) {
    const note = detail.agentExists
      ? "No usage recorded for this agent in this window."
      : "No usage recorded for this agent.";
    return `${header}\n${note}\n`;
  }

  const showCost = hasPricedCost(detail.totals, detail.models);
  const numericWidth = NUMERIC_COLUMNS_WIDTH + (showCost ? COST_COLUMN_WIDTH : 0);
  const modelWidth = textColumnWidth(options.width, SCOPE_MAX_WIDTH, numericWidth);
  const modelRows = detail.models.map((model) =>
    totalsRow(fitCell(model.key, modelWidth), model, showCost),
  );
  if (detail.models.length > 1) {
    modelRows.push(totalsRow("TOTAL", detail.totals, showCost));
  }
  const modelTable = renderTable({
    columns: [{ key: "scope", header: "model", maxWidth: modelWidth }, ...usageColumns(showCost)],
    rows: modelRows,
    width: options.width,
  });

  // The day table carries a fixed-width date column too, so the model list gets
  // whatever is left after the date and the numeric columns.
  const dayModelsWidth = Math.max(
    MIN_TEXT_WIDTH,
    textColumnWidth(options.width, SCOPE_MAX_WIDTH, numericWidth) - DAY_COLUMN_WIDTH,
  );
  const dayRows = detail.days.map((day) => ({
    ...totalsRow(day.day, day, showCost),
    models: summarizeDayModels(day.models, dayModelsWidth - CELL_PADDING),
  }));
  const dayTable = renderTable({
    columns: [
      { key: "scope", header: "day" },
      ...usageColumns(showCost),
      { key: "models", header: "models", maxWidth: dayModelsWidth },
    ],
    rows: dayRows,
    width: options.width,
  });

  const parts = [header, modelTable, `By day (${detail.days.length}):`, dayTable];
  if (detail.skippedUndated > 0) {
    parts.push(`${detail.skippedUndated} turn(s) without timestamps excluded from the day view.`);
  }
  return `${parts.join("\n")}\n`;
}
