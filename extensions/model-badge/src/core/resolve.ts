// Model resolution (ported). `entry.model` is deliberately never read: it records the
// last run, not the model the next turn will use.

export type SessionEntryLike = {
  providerOverride?: unknown;
  modelOverride?: unknown;
  model?: unknown;
};

export function defaultModelOf(gatewayConfig: unknown): string | null {
  const d = (gatewayConfig as { agents?: { defaults?: { model?: unknown } } } | undefined)?.agents
    ?.defaults?.model;
  const v = typeof d === "string" ? d : (d as { primary?: unknown } | undefined)?.primary;
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

export function resolveModel(
  entry: SessionEntryLike | undefined,
  defaultModel: string | null,
): { model: string | null; pinned: boolean } {
  const p = entry?.providerOverride;
  const m = entry?.modelOverride;
  if (typeof p === "string" && p && typeof m === "string" && m) {
    return { model: `${p}/${m}`, pinned: true };
  }
  return { model: defaultModel, pinned: false };
}

// Available set = qualified ids in the agent's models.json plus the configured default.
export function availableModels(modelsJson: unknown, defaultModel: string | null): Set<string> {
  const out = new Set<string>();
  const providers = (
    modelsJson as { providers?: Record<string, { models?: Array<{ id?: unknown }> }> } | undefined
  )?.providers;
  if (providers && typeof providers === "object") {
    for (const [key, prov] of Object.entries(providers)) {
      for (const m of Array.isArray(prov?.models) ? prov.models : []) {
        if (typeof m?.id === "string" && m.id) {
          out.add(`${key}/${m.id}`);
        }
      }
    }
  }
  if (defaultModel) {
    out.add(defaultModel);
  }
  return out;
}

// What the watcher compares per session to detect a model swap.
export function overrideSnapshot(entry: SessionEntryLike | undefined): string {
  return JSON.stringify([entry?.providerOverride ?? null, entry?.modelOverride ?? null]);
}

export function modelSuffix(model: string): string {
  const i = model.indexOf("/");
  return i === -1 ? model : model.slice(i + 1);
}

export function modelProviderKey(model: string): string {
  const i = model.indexOf("/");
  return i === -1 ? "" : model.slice(0, i);
}
