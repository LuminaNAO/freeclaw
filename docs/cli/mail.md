---
summary: "CLI reference for `openclaw mail` (mail push connectors)"
read_when:
  - You want to inspect, test or restart a mail connector
title: "mail"
---

# `openclaw mail`

Inspect and control mail push connectors (`mail.connectors`). Each verb calls one gateway method;
`--json` prints the method result as-is.

Related:

- Setup and behaviour: [Mail push](/automation/mail-push)

## Commands

```bash
openclaw mail connectors list [--json]          # mail.connectors.list
openclaw mail connectors status [<id>] [--json] # mail.connectors.status
openclaw mail connectors test <id> [--json]     # mail.connectors.test (connect + auth + folder, no side effects)
openclaw mail connectors restart <id> [--json]  # mail.connectors.restart (also clears auth-failed)
```

`test` exits with code 1 when the check fails. All commands accept the usual gateway client
options (`--url`, `--token`, `--timeout`).
