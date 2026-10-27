---
summary: "Generated voice messages carry their transcript and are real voice notes on Signal (ARCH, operator-owned)"
title: "Voice messages: transcript caption + Signal voice notes"
---

# Voice messages: transcript caption + Signal voice notes — ARCH (operator)

Owned by the operator; engineers never edit this file. Every commit names the section it implements.

## 1. Problem
When an agent sends TTS audio on Signal, the message body is the placeholder `<media:audio>` (src/signal/send.ts fills
an empty body with `<media:${kind}>`), so the reader sees a meaningless tag under the audio. The audio also arrives
as a generic file attachment, not a Signal voice note (the TTS output for Signal is mp3; Signal is not in the
voice-bubble channel set; the send path never sets signal-cli's voice-note flag).

## 2. Behaviour
1. **Transcript caption.** Audio produced by the `tts` tool (and by auto-TTS replies) is delivered with its text as
   the message body: the exact text that was spoken (after any summarisation, i.e. what the audio actually says).
   This applies on every channel that supports a caption/body with media; on Signal it replaces the placeholder.
2. **Never `<media:…>` as visible text for our own outbound media.** In src/signal/send.ts an empty body with an
   attachment is sent with an empty body (Signal accepts attachment-only messages), not a `<media:kind>`
   placeholder. Inbound placeholders (what the agent sees for received media) are unchanged.
3. **Signal voice notes.** Signal joins the voice-compatible channel set for TTS output (Opus in Ogg, mono, like
   Telegram), and audio flagged `audioAsVoice` (the existing `[[audio_as_voice]]` tag the tts tool already emits for
   voice-compatible output) is sent with signal-cli's voice-note flag (JSON-RPC `send` param for voice note; check
   the daemon's RPC param name against signal-cli 0.14.x and record it). Result: a playable voice bubble with the
   transcript under it.
4. **How the transcript travels.** The tts tool result carries the spoken text (e.g. a `[[media_caption:…]]`-style
   directive alongside `MEDIA:` or `details.transcript`, whichever fits the existing tool-media parsing with the
   fewest moving parts); the outbound payload uses it as the body for that media item. If the agent's own reply
   text is also delivered with the same media, the agent text wins and the transcript is not duplicated.
5. Long transcripts follow the channel's normal text limits (chunked after the media message if needed).

## 3. Tests
- tts tool on Signal: payload has the media, body = spoken text, audioAsVoice set, format opus/ogg.
- Signal send with attachment and empty body: no `<media:audio>` body; with voice flag: RPC carries the voice-note
  param; without it: unchanged.
- Summarised TTS: body = the summary that was spoken, not the original text.
- Telegram behaviour unchanged (voice bubble, caption now = transcript).
- Inbound `<media:audio>` placeholder handling unchanged.

## 4. Acceptance
Touched suites green, `pnpm build` green. Live on the dev gateway: the agent's tts tool on Signal arrives as a voice
note bubble with the transcript as its text.
