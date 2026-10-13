import path from "node:path";
import { isHex } from "./color.js";
import { isMotif, MOTIFS } from "./motif.js";
import { PALETTE_NAMES } from "./palette.js";

// Plugin config (plugins.entries.model-badge.config). Everything operator-specific is
// runtime config; nothing here is committed data (ARCH §2.4).

export type BadgeRule = {
  pattern: string;
  letter: string;
  color: string;
  textDark?: boolean;
};
export type TargetOverride = { motif?: string; palette?: string };

export type SecretRefLike = { source: string; provider: string; id: string };

export type ImageGenConfig =
  | {
      kind: "openai-images";
      baseUrl: string;
      model: string;
      size: string;
      apiKey: SecretRefLike;
      seed: boolean;
      timeoutMs: number;
      maxAttempts: number;
      maxPerDay: number;
      maxPerRun: number;
    }
  | {
      kind: "command";
      command: string;
      args: string[];
      timeoutMs: number;
      maxAttempts: number;
      maxPerDay: number;
      maxPerRun: number;
    };

export const DEFAULT_TIMING = {
  watchMs: 3000,
  debounceMs: 1500,
  queueSpacingMs: 2000,
  reconcileIntervalMs: 600_000,
  rpcTimeoutMs: 30_000,
  renderTimeoutMs: 20_000,
  renderConcurrency: 2,
  pruneGraceMs: 86_400_000,
  listTargetsMinRefreshMs: 60_000,
  rateLimitBaseMs: 30_000,
  rateLimitMaxBackoffMs: 900_000,
  captchaMinPauseMs: 3_600_000,
  captchaMaxPauseMs: 86_400_000,
  errorBackoffBaseMs: 60_000,
  imageGenBackoffMs: 600_000,
  // ARCH §2c.4: image retries back off from imageGenBackoffMs, capped here.
  imageGenMaxBackoffMs: 1_800_000,
  leaseHeartbeatMs: 30_000,
  leaseTtlMs: 120_000,
};

export const DEFAULT_LIMITS = {
  maxAttempts: 5,
  maxArtAttempts: 3,
  ioErrorParkThreshold: 10,
};

export type Timing = typeof DEFAULT_TIMING;
export type Limits = typeof DEFAULT_LIMITS;

export type ProviderBlock = Record<string, unknown>;

export type ModelBadgeConfig = {
  providers: string[];
  providerBlocks: Record<string, ProviderBlock>;
  agentId: string;
  operators: string[];
  badges: BadgeRule[];
  targets: Record<string, TargetOverride>;
  steering: { allowGroupMembers: boolean; rules: unknown[] };
  imageGen: ImageGenConfig | null;
  stateDir: string;
  timing: Timing;
  limits: Limits;
};

export type NormalizeResult =
  | { ok: true; config: ModelBadgeConfig }
  | { ok: false; errors: string[]; config: ModelBadgeConfig };

// ARCH §2c.4: defaults sized for a local generator; operators lower them for metered backends.
export const IMAGE_DEFAULTS = {
  timeoutMs: 120_000,
  maxAttempts: 10,
  maxPerDay: 200,
  maxPerRun: 16,
};

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function posInt(v: unknown, fallback: number): number {
  return Number.isInteger(v) && (v as number) > 0 ? (v as number) : fallback;
}

function isSecretRef(v: unknown): v is SecretRefLike {
  const r = obj(v);
  return (
    typeof r.source === "string" &&
    ["env", "file", "exec"].includes(r.source) &&
    typeof r.provider === "string" &&
    typeof r.id === "string" &&
    r.id.length > 0
  );
}

function normalizeImageGen(raw: unknown, errors: string[]): ImageGenConfig | null {
  if (raw === undefined || raw === null) {
    return null;
  }
  const c = obj(raw);
  const common = {
    timeoutMs: posInt(c.timeoutMs, IMAGE_DEFAULTS.timeoutMs),
    maxAttempts: posInt(c.maxAttempts, IMAGE_DEFAULTS.maxAttempts),
    maxPerDay:
      Number.isInteger(c.maxPerDay) && (c.maxPerDay as number) >= 0
        ? (c.maxPerDay as number)
        : IMAGE_DEFAULTS.maxPerDay,
    maxPerRun:
      Number.isInteger(c.maxPerRun) && (c.maxPerRun as number) >= 0
        ? (c.maxPerRun as number)
        : IMAGE_DEFAULTS.maxPerRun,
  };
  if (c.kind === "openai-images") {
    if (typeof c.baseUrl !== "string" || !/^https?:\/\//.test(c.baseUrl)) {
      errors.push("imageGen.baseUrl must be an http(s) URL");
    }
    if (typeof c.model !== "string" || !c.model) {
      errors.push("imageGen.model is required");
    }
    // ARCH §2b.1: the key is a SecretRef only, never a literal in config.
    if (!isSecretRef(c.apiKey)) {
      errors.push("imageGen.apiKey must be a SecretRef ({ source, provider, id })");
    }
    return {
      kind: "openai-images",
      baseUrl: String(c.baseUrl ?? "").replace(/\/+$/, ""),
      model: String(c.model ?? ""),
      size: typeof c.size === "string" && c.size ? c.size : "1024x1024",
      apiKey: isSecretRef(c.apiKey) ? c.apiKey : { source: "env", provider: "default", id: "" },
      seed: c.seed === true,
      ...common,
    };
  }
  if (c.kind === "command") {
    if (typeof c.command !== "string" || !path.isAbsolute(c.command)) {
      errors.push("imageGen.command must be an absolute path");
    }
    const args = Array.isArray(c.args) ? c.args.map(String) : [];
    return { kind: "command", command: String(c.command ?? ""), args, ...common };
  }
  errors.push('imageGen.kind must be "openai-images" or "command"');
  return null;
}

export function normalizeConfig(raw: unknown, ctx: { gatewayStateDir: string }): NormalizeResult {
  const errors: string[] = [];
  const c = obj(raw);

  const providers =
    Array.isArray(c.providers) && c.providers.length > 0
      ? [...new Set(c.providers.map(String))]
      : ["signal"];
  const providerBlocks: Record<string, ProviderBlock> = {};
  for (const id of providers) {
    if (!/^[a-z][a-z0-9-]*$/.test(id)) {
      errors.push(`providers: invalid provider id "${id}"`);
    }
    providerBlocks[id] = obj(c[id]);
  }

  const badges: BadgeRule[] = [];
  if (c.badges !== undefined && !Array.isArray(c.badges)) {
    errors.push("badges must be an array of { pattern, letter, color } rules");
  }
  for (const [i, b] of (Array.isArray(c.badges) ? c.badges : []).entries()) {
    const r = obj(b);
    if (typeof r.pattern !== "string" || !r.pattern) {
      errors.push(`badges[${i}].pattern is required`);
      continue;
    }
    if (typeof r.letter !== "string" || !/^[A-Za-z0-9?]{1,2}$/.test(r.letter)) {
      errors.push(`badges[${i}].letter must be 1-2 letters or digits`);
      continue;
    }
    if (!isHex(r.color)) {
      errors.push(`badges[${i}].color must be #RRGGBB`);
      continue;
    }
    badges.push({
      pattern: r.pattern,
      letter: r.letter.toUpperCase(),
      color: r.color.toUpperCase(),
      textDark: typeof r.textDark === "boolean" ? r.textDark : undefined,
    });
  }

  const targets: Record<string, TargetOverride> = {};
  for (const [k, v] of Object.entries(obj(c.targets))) {
    const o = obj(v);
    if (o.motif !== undefined && !isMotif(o.motif)) {
      errors.push(`targets.${k}.motif must be one of ${MOTIFS.join(", ")}`);
    }
    if (
      o.palette !== undefined &&
      !(typeof o.palette === "string" && PALETTE_NAMES.includes(o.palette.toLowerCase()))
    ) {
      errors.push(`targets.${k}.palette must be one of ${PALETTE_NAMES.join(", ")}`);
    }
    targets[k.toLowerCase()] = {
      motif: isMotif(o.motif) ? o.motif : undefined,
      palette: typeof o.palette === "string" ? o.palette.toLowerCase() : undefined,
    };
  }

  const steeringRaw = obj(c.steering);
  const steering = {
    // ARCH §2c.2: members may act on their own group unless the operator turns it off.
    allowGroupMembers: steeringRaw.allowGroupMembers !== false,
    rules: Array.isArray(steeringRaw.rules) ? steeringRaw.rules : [],
  };

  const imageGen = normalizeImageGen(c.imageGen, errors);

  const paths = obj(c.paths);
  const stateDir =
    typeof paths.stateDir === "string" && paths.stateDir
      ? paths.stateDir
      : path.join(ctx.gatewayStateDir, "plugins", "model-badge");
  if (!path.isAbsolute(stateDir)) {
    errors.push("paths.stateDir must be absolute");
  }

  const timing = { ...DEFAULT_TIMING };
  for (const [k, v] of Object.entries(obj(c.timing))) {
    if (k in timing && typeof v === "number" && Number.isFinite(v) && v >= 0) {
      (timing as Record<string, number>)[k] = v;
    }
  }
  const limits = { ...DEFAULT_LIMITS };
  for (const [k, v] of Object.entries(obj(c.limits))) {
    if (k in limits && Number.isInteger(v) && (v as number) > 0) {
      (limits as Record<string, number>)[k] = v as number;
    }
  }

  const config: ModelBadgeConfig = {
    providers,
    providerBlocks,
    agentId: typeof c.agentId === "string" && c.agentId ? c.agentId : "main",
    operators: Array.isArray(c.operators) ? c.operators.map(String).filter(Boolean) : [],
    badges,
    targets,
    steering,
    imageGen,
    stateDir,
    timing,
    limits,
  };
  return errors.length ? { ok: false, errors, config } : { ok: true, config };
}
