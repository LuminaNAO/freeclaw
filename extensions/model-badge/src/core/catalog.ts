import { modelProviderKey, modelSuffix } from "./resolve.js";

// ARCH §2a.2: model grouping is resolved, not guessed. A model's provider is the key it
// is listed under in the agent's model catalog (models.json). Because a catalog key can
// be a proxy alias, the model family (first token of the model id) is also mapped to
// its maker through a fixed table in code. Common words users say map onto those
// providers and families through the alias table below.

export const FAMILY_PROVIDER: Readonly<Record<string, string>> = {
  claude: "anthropic",
  gpt: "openai",
  chatgpt: "openai",
  o1: "openai",
  o3: "openai",
  o4: "openai",
  codex: "openai",
  kimi: "moonshot",
  moonshot: "moonshot",
  gemini: "google",
  gemma: "google",
  grok: "xai",
  llama: "meta",
  mistral: "mistral",
  mixtral: "mistral",
  codestral: "mistral",
  deepseek: "deepseek",
  qwen: "qwen",
  glm: "zhipu",
  minimax: "minimax",
};

// Words a user may use for a provider → canonical provider id.
export const PROVIDER_ALIASES: Readonly<Record<string, string>> = {
  anthropic: "anthropic",
  claude: "anthropic",
  openai: "openai",
  gpt: "openai",
  chatgpt: "openai",
  moonshot: "moonshot",
  kimi: "moonshot",
  google: "google",
  gemini: "google",
  xai: "xai",
  grok: "xai",
  meta: "meta",
  llama: "meta",
  mistral: "mistral",
  deepseek: "deepseek",
  qwen: "qwen",
  alibaba: "qwen",
  zhipu: "zhipu",
  glm: "zhipu",
  minimax: "minimax",
};

export type ModelInfo = {
  id: string;
  providerKey: string;
  family: string;
  providers: string[];
};

export function familyOf(model: string): string {
  const first =
    modelSuffix(model)
      .toLowerCase()
      .split(/[-_.:/\s]+/)[0] ?? "";
  if (first in FAMILY_PROVIDER) {
    return first;
  }
  const letters = /^[a-z]+/.exec(first)?.[0];
  return letters && letters in FAMILY_PROVIDER ? letters : letters || first;
}

export function describeModel(model: string): ModelInfo {
  const providerKey = modelProviderKey(model).toLowerCase();
  const family = familyOf(model);
  const providers = new Set<string>();
  if (providerKey) {
    providers.add(PROVIDER_ALIASES[providerKey] ?? providerKey);
  }
  const maker = FAMILY_PROVIDER[family];
  if (maker) {
    providers.add(maker);
  }
  return { id: model, providerKey, family, providers: [...providers].toSorted() };
}

// Canonical provider for a user word, if the word names one we can resolve against the
// given models. Unknown words return null (the caller rejects with suggestions).
export function canonicalProvider(word: string, known: Iterable<ModelInfo>): string | null {
  const w = word.trim().toLowerCase();
  const alias = PROVIDER_ALIASES[w];
  const all = new Set<string>();
  for (const m of known) {
    for (const p of m.providers) {
      all.add(p);
    }
  }
  if (alias && all.has(alias)) {
    return alias;
  }
  return all.has(w) ? w : null;
}

export function canonicalFamily(word: string, known: Iterable<ModelInfo>): string | null {
  const w = word.trim().toLowerCase();
  const fams = new Set<string>();
  for (const m of known) {
    fams.add(m.family);
  }
  if (fams.has(w)) {
    return w;
  }
  const viaAlias = w === "chatgpt" ? "gpt" : null;
  return viaAlias && fams.has(viaAlias) ? viaAlias : null;
}

export function knownGroups(models: Iterable<ModelInfo>): {
  providers: string[];
  families: string[];
} {
  const providers = new Set<string>();
  const families = new Set<string>();
  for (const m of models) {
    for (const p of m.providers) {
      providers.add(p);
    }
    families.add(m.family);
  }
  return { providers: [...providers].toSorted(), families: [...families].toSorted() };
}

export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (const ch of glob) {
    if (ch === "*") {
      re += ".*";
    } else if (ch === "?") {
      re += ".";
    } else {
      re += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${re}$`, "i");
}
