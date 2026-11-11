// Provider factory (docs/design/mail-push.md §5): `src/mail/providers/<name>.ts`.
import type { MailConnectorConfig } from "../../config/types.mail.js";
import type { MailLogger, MailProvider } from "../types.js";
import { FakeMailProvider, getFakeMailbox } from "./fake.js";
import { ImapMailProvider, type ImapProviderOptions } from "./imap.js";

export type MailProviderFactoryParams = {
  config: MailConnectorConfig;
  /** Resolved IMAP password (imap provider only). */
  password?: string;
  log: MailLogger;
  imapOverrides?: Partial<Omit<ImapProviderOptions, "connectorId" | "imap" | "password" | "log">>;
};

export function createMailProvider(params: MailProviderFactoryParams): MailProvider {
  const { config } = params;
  if (config.provider === "fake") {
    return new FakeMailProvider(getFakeMailbox(config.id));
  }
  if (!config.imap) {
    throw new Error(`mail connector ${config.id}: imap settings missing`);
  }
  if (!params.password) {
    throw new Error(`mail connector ${config.id}: imap password not resolved`);
  }
  return new ImapMailProvider({
    connectorId: config.id,
    imap: config.imap,
    password: params.password,
    log: params.log,
    maxBodyChars: config.body?.maxChars,
    ...params.imapOverrides,
  });
}
