import type { CronJob } from "../types.js";

/**
 * Maximum wall-clock time for a single job execution. Acts as a safety net
 * on top of per-provider/per-agent timeouts to prevent one stuck job from
 * wedging the entire cron lane.
 */
export const DEFAULT_JOB_TIMEOUT_MS = 10 * 60_000; // 10 minutes

/**
 * Agent turns have no outer wall-clock ceiling unless the job sets `timeoutSeconds`: the embedded run
 * applies agents.defaults.timeoutSeconds (opt-in) and the stall watchdog ends runs that stop progressing.
 */
export function resolveCronJobTimeoutMs(job: CronJob): number | undefined {
  if (job.payload.kind !== "agentTurn") {
    return DEFAULT_JOB_TIMEOUT_MS;
  }
  if (typeof job.payload.timeoutSeconds !== "number") {
    return undefined;
  }
  const configuredTimeoutMs = Math.floor(job.payload.timeoutSeconds * 1_000);
  return configuredTimeoutMs <= 0 ? undefined : configuredTimeoutMs;
}
