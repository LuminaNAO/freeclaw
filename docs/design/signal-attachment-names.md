---
summary: "Files sent on Signal arrive with their real file name, not a random id (ARCH, operator-owned)"
title: "Outbound attachments keep their file name"
---

# Outbound attachments keep their file name — ARCH (operator, 2026-11-12)

Owned by the operator; engineers never edit this file. Every commit names the section it implements.

## 1. Problem

A file an agent sends on Signal arrives named `<random uuid>.pdf`. Cause: `resolveOutboundAttachmentFromUrl`
(src/media/outbound-attachment.ts) loads the media, then calls `saveMediaBuffer` without a file name, so the copy
handed to signal-cli is `media/outbound/<uuid><ext>`. signal-cli sends the on-disk base name as the attachment
name. `loadWebMedia` already returns the source's `fileName`; it is dropped. iMessage uses the same function.

Agents work around it today with their own raw sends. That must not be needed: a new agent gets real names with no
setup, no config and no instruction.

## 2. Behaviour

1. **The receiver sees the source's file name.** For every outbound attachment resolved through
   `resolveOutboundAttachmentFromUrl` (Signal replies with media, the message tool's `send` with a file, iMessage),
   the copy handed to the channel CLI has the source's file name as its base name:
   - local path or `file://` URL: the base name of the source path;
   - `http(s)` URL: the name `loadWebMedia` reports (response header name, else the URL's base name);
   - a name without an extension gets the one `loadWebMedia` already adds from the MIME type; a converted image
     keeps the converted name `loadWebMedia` reports (e.g. HEIC to `.jpg`).
2. **One private folder per send.** The copy is written to `media/outbound/<fresh uuid>/<file name>`: folder and
   file created with the same modes as today's media writes. Two sends of the same name never collide and never
   overwrite. The function returns that path; nothing else about the send changes (size limit, allowed source
   roots, MIME detection, voice-note flag, caption handling).
3. **Safe names.** The name is only ever a base name inside that folder. From the reported name: take the base name
   (both `/` and `\` are separators), drop control characters and NUL, trim surrounding whitespace, drop leading
   dots, cap at 120 characters while keeping the extension. Letters and digits of any script, spaces and ordinary
   punctuation stay as they are. If nothing usable is left, fall back to exactly today's behaviour
   (`media/outbound/<uuid><ext>`). The written path is checked to be inside the per-send folder before writing.
4. **Cleanup unchanged in effect.** The existing periodic media cleanup (recursive, prunes empty folders) removes
   the file after the media TTL and then its empty per-send folder. No new timer, no new config.
5. **No config, no migration.** No new setting. Existing files under `media/outbound/` are left to the normal
   cleanup. Inbound media naming is unchanged.
6. **Out of scope:** an explicit rename parameter on a send (the agent names the file before sending); other
   channels that upload buffers with their own file-name field (they already carry the name); the message tool's
   `buffer` input.

## 3. Tests (all required)

1. Local source `…/Report Q3 (final).pdf`: returned path's base name is `Report Q3 (final).pdf`, its parent is a
   uuid-named folder directly under `media/outbound/`, bytes identical, modes as in item 2.
2. Same name sent twice: two different folders, both files intact.
3. `http(s)` source: header name used; without a header name the URL base name; no extension + known MIME gets the
   extension.
4. No usable name (empty, only dots, only separators): today's `media/outbound/<uuid><ext>`.
5. Hostile names never escape the folder and never fail the send: `../../x.pdf`, an absolute path, backslash
   paths, embedded NUL and control characters, a leading-dot name, a 300-character name (capped, extension kept),
   non-Latin letters (kept).
6. Signal send: the attachment path given to the RPC is the returned path; voice-note behaviour unchanged; existing
   Signal send tests stay green (adjust only what the new path shape requires).
7. iMessage send: existing tests green with the new path shape.
8. Cleanup: a per-send folder older than the TTL is removed with its file by the periodic cleanup; a fresh one
   survives.
9. docs/channels/signal.md says in one line that sent files keep their file name.

## 4. Live proof (operator, after the build; not part of the swarm)

On the test gateway: send a file named `Name With Spaces.pdf` to another account as a reply attachment and through
the message tool. The receiving side's attachment file name is `Name With Spaces.pdf` both times.
