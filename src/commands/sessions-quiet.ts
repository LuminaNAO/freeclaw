import { loadConfig } from "../config/config.js";
import { loadSessionStore } from "../config/sessions.js";
import { resolveGatewaySessionStoreTarget } from "../gateway/session-utils.js";
import type { RuntimeEnv } from "../runtime.js";
import {
  formatQuietSessionSettings,
  resolveQuietSessionSettings,
  setQuietSessionSettings,
} from "../sessions/quiet-settings.js";

/**
 * Quiet sessions ARCH §3.1: `openclaw sessions set <key> [--no-error-replies] [--no-slash-commands]`
 * (and `--error-replies` / `--slash-commands` to restore). Operator CLI; writes the session store
 * directly, like `openclaw sessions cleanup`.
 */
export async function sessionsSetCommand(
  opts: { key: string; errorReplies?: boolean; slashCommands?: boolean; json?: boolean },
  runtime: RuntimeEnv,
): Promise<void> {
  if (opts.errorReplies === undefined && opts.slashCommands === undefined) {
    throw new Error(
      "Nothing to set. Use --no-error-replies / --error-replies and/or --no-slash-commands / --slash-commands.",
    );
  }
  const cfg = loadConfig();
  const target = resolveGatewaySessionStoreTarget({ cfg, key: opts.key });
  const result = await setQuietSessionSettings({
    storePath: target.storePath,
    storeKeys: target.storeKeys,
    patch: { errorReplies: opts.errorReplies, slashCommands: opts.slashCommands },
  });
  if (!result.ok) {
    throw new Error(result.error);
  }
  if (opts.json) {
    runtime.log(
      JSON.stringify(
        { key: result.key, changed: result.changed, ...resolveQuietSessionSettings(result.entry) },
        null,
        2,
      ),
    );
    return;
  }
  runtime.log(`${result.changed ? "Updated" : "Unchanged"}: ${result.key}`);
  for (const line of formatQuietSessionSettings(result.entry)) {
    runtime.log(`  ${line}`);
  }
}

/** Quiet sessions ARCH §3.3: `openclaw sessions show <key>`. */
export async function sessionsShowCommand(
  opts: { key: string; json?: boolean },
  runtime: RuntimeEnv,
): Promise<void> {
  const cfg = loadConfig();
  const target = resolveGatewaySessionStoreTarget({ cfg, key: opts.key });
  const store = loadSessionStore(target.storePath);
  const key = target.storeKeys.find((candidate) => Boolean(store[candidate]));
  if (!key) {
    throw new Error(`session not found: ${opts.key}`);
  }
  const entry = store[key];
  if (opts.json) {
    runtime.log(
      JSON.stringify(
        {
          key,
          sessionId: entry.sessionId,
          updatedAt: entry.updatedAt,
          ...resolveQuietSessionSettings(entry),
          lastSuppressedError: entry.lastSuppressedError ?? null,
        },
        null,
        2,
      ),
    );
    return;
  }
  runtime.log(`Session: ${key}`);
  runtime.log(`  sessionId: ${entry.sessionId}`);
  if (entry.updatedAt) {
    runtime.log(`  updatedAt: ${new Date(entry.updatedAt).toISOString()}`);
  }
  for (const line of formatQuietSessionSettings(entry)) {
    runtime.log(`  ${line}`);
  }
  if (entry.lastSuppressedError) {
    runtime.log(
      `  lastSuppressedError: ${new Date(entry.lastSuppressedError.at).toISOString()} ${entry.lastSuppressedError.text}`,
    );
  }
}
