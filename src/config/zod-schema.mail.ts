// Mail push connectors (docs/design/mail-push.md §3): `mail.connectors`.
import path from "node:path";
import { z } from "zod";
import { normalizeThinkLevel } from "../auto-reply/thinking.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { parseAgentSessionKey } from "../sessions/session-key-utils.js";
import { SecretRefSchema } from "./zod-schema.core.js";
import { sensitive } from "./zod-schema.sensitive.js";

export const MAIL_CONNECTOR_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
export const MAIL_MIN_POLL_SECONDS = 15;

/** True for hosts where a plaintext IMAP connection never leaves the machine. */
export function isMailLoopbackHost(host: string): boolean {
  const value = host.trim().toLowerCase();
  return /^127(?:\.\d{1,3}){3}$/.test(value) || value === "::1" || value === "[::1]";
}

function isWorkspaceRelativePath(raw: string): boolean {
  const value = raw.trim();
  if (!value || path.isAbsolute(value) || value.startsWith("~") || /^[a-z]:/i.test(value)) {
    return false;
  }
  return !value.split(/[\\/]+/).some((part) => part === "..");
}

const GlobListSchema = z.array(z.string().trim().min(1)).optional();

const MailImapSchema = z
  .object({
    host: z.string().trim().min(1),
    port: z.number().int().min(1).max(65535).optional(),
    tls: z.union([z.boolean(), z.literal("starttls")]).optional(),
    user: z.string().trim().min(1),
    password: SecretRefSchema.register(sensitive),
    folders: z.array(z.string().trim().min(1)).min(1).optional(),
    idle: z.boolean().optional(),
    pollSeconds: z.number().int().min(MAIL_MIN_POLL_SECONDS).optional(),
  })
  .strict()
  .superRefine((imap, ctx) => {
    if (imap.tls === false && !isMailLoopbackHost(imap.host)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["tls"],
        message:
          'tls: false is only allowed for a loopback host (127.0.0.1); use true or "starttls".',
      });
    }
  });

const MailFilterSchema = z
  .object({
    from: GlobListSchema,
    to: GlobListSchema,
    subjectIncludes: GlobListSchema,
    excludeFrom: GlobListSchema,
    maxAgeMinutes: z.number().int().positive().optional(),
  })
  .strict();

const MailBodySchema = z
  .object({
    maxChars: z.number().int().min(1).max(200_000).optional(),
    attachments: z.union([z.literal("none"), z.literal("names")]).optional(),
  })
  .strict();

const MailBatchSchema = z
  .object({
    windowSeconds: z.number().min(0).max(3600).optional(),
    max: z.number().int().min(1).max(100).optional(),
  })
  .strict();

const MailAttachSchema = z
  .object({
    agentId: z.string().trim().min(1),
    sessionKey: z.string().trim().min(1),
    wakeMode: z.union([z.literal("now"), z.literal("next-heartbeat")]).optional(),
    deliver: z.boolean().optional(),
    channel: z.string().trim().min(1).nullable().optional(),
    to: z.string().trim().min(1).nullable().optional(),
    instructionsFile: z
      .string()
      .refine(isWorkspaceRelativePath, "instructionsFile must be a workspace-relative path")
      .optional(),
    model: z.string().trim().min(1).nullable().optional(),
    thinking: z
      .string()
      .refine((value) => normalizeThinkLevel(value) !== undefined, "unknown thinking level")
      .nullable()
      .optional(),
  })
  .strict()
  .superRefine((attach, ctx) => {
    const parsed = parseAgentSessionKey(attach.sessionKey);
    if (!parsed) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["sessionKey"],
        message: `sessionKey must be an agent session key (agent:${normalizeAgentId(attach.agentId)}:...)`,
      });
    } else if (parsed.agentId !== normalizeAgentId(attach.agentId)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["sessionKey"],
        message: `sessionKey belongs to agent "${parsed.agentId}", not "${normalizeAgentId(attach.agentId)}"`,
      });
    }
    if (attach.deliver === true) {
      const channel = attach.channel?.trim();
      const to = attach.to?.trim();
      if (!channel || (channel !== "last" && !to)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["deliver"],
          message: 'deliver: true needs channel and to (or channel: "last")',
        });
      }
    }
  });

const MailConnectorSchema = z
  .object({
    id: z
      .string()
      .regex(
        MAIL_CONNECTOR_ID_PATTERN,
        "connector id must use lowercase letters, digits and dashes ([a-z0-9-])",
      ),
    enabled: z.boolean().optional(),
    provider: z.union([z.literal("imap"), z.literal("fake")]),
    imap: MailImapSchema.optional(),
    filter: MailFilterSchema.optional(),
    body: MailBodySchema.optional(),
    batch: MailBatchSchema.optional(),
    attach: z.array(MailAttachSchema),
  })
  .strict()
  .superRefine((connector, ctx) => {
    if (connector.enabled !== false && connector.attach.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["attach"],
        message: "attach must list at least one session when the connector is enabled",
      });
    }
    if (connector.provider === "imap" && !connector.imap) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["imap"],
        message: 'provider "imap" needs an imap block',
      });
    }
    if (connector.provider !== "imap" && connector.imap) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["imap"],
        message: `imap settings do not apply to provider "${connector.provider}"`,
      });
    }
  });

export const MailSchema = z
  .object({
    connectors: z
      .array(MailConnectorSchema)
      .superRefine((connectors, ctx) => {
        const seen = new Set<string>();
        connectors.forEach((connector, index) => {
          if (seen.has(connector.id)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: [index, "id"],
              message: `duplicate connector id "${connector.id}"`,
            });
          }
          seen.add(connector.id);
        });
      })
      .optional(),
  })
  .strict()
  .optional();
