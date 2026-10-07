// Route table: data, not code (ARCH §5).

export const TASKMASTER = "taskmaster";
export const UPSTREAM = "upstream";
/** Placeholder target for RETRY: resolved to the `role` argument of the emit. */
export const ROLE_PLACEHOLDER = "{{role}}";
export const ANY = "*";

export type RouteRow = {
  on: string;
  from: string;
  to: string;
  message: string;
  /** Reserved for fan-out (ARCH §6); must be 1 or absent in the MVP. */
  count?: number;
  /** Reserved for join (ARCH §6); must be absent in the MVP. */
  join?: string;
};

/** ARCH §5 default build template, as data. */
export const DEFAULT_BUILD_ROUTES: readonly RouteRow[] = Object.freeze([
  { on: "BUILD_DONE", from: "build", to: "audit", message: "review {{sha}}" },
  { on: "AUDIT_FAIL", from: "audit", to: "build", message: "audit findings" },
  { on: "AUDIT_PASS", from: "audit", to: "test", message: "test {{sha}}" },
  { on: "TEST_FAIL", from: "test", to: "build", message: "repro + failing test" },
  { on: "TEST_PASS", from: "test", to: TASKMASTER, message: "gate passed {{sha}}" },
  { on: "DONE", from: TASKMASTER, to: UPSTREAM, message: "done" },
  { on: "BLOCKED", from: TASKMASTER, to: UPSTREAM, message: "human needed" },
  { on: "BLOCKED", from: ANY, to: TASKMASTER, message: "blocked" },
  { on: "FAILED", from: TASKMASTER, to: UPSTREAM, message: "failed" },
  { on: "RETRY", from: TASKMASTER, to: ROLE_PLACEHOLDER, message: "re-prompt" },
]);

export const TEMPLATES: Readonly<Record<string, readonly RouteRow[]>> = Object.freeze({
  build: DEFAULT_BUILD_ROUTES,
});

/** Events that close a task when routed upstream. */
export const TERMINAL_EVENTS: ReadonlySet<string> = new Set(["DONE", "FAILED", "CANCELLED"]);

/** Exact `from` beats the `*` wildcard; first matching row wins. */
export function resolveRoute(
  routes: readonly RouteRow[],
  query: { event: string; from: string },
): RouteRow | null {
  const exact = routes.find((r) => r.on === query.event && r.from === query.from);
  if (exact) {
    return exact;
  }
  return routes.find((r) => r.on === query.event && r.from === ANY) ?? null;
}

export function renderRouteMessage(template: string, vars: { sha: string }): string {
  return template.replace(/\{\{sha\}\}|\{sha\}/g, vars.sha);
}
