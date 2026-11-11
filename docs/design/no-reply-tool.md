# Silent replies as a tool: `no_reply`

Status: design (operator, 2026-11-10). Owner of this file: operator. Builders do not edit it; a disagreement is raised, not patched.

## 1. Problem

Today a model stays quiet by answering with the text token `NO_REPLY` (`src/auto-reply/tokens.ts`).
Models, frontier ones included, bundle it with real text ("Here you go... NO_REPLY", "NO_REPLY\nHi").
The runtime then has to guess: deliver the rest, drop all of it, or leak the token. Group chats suffer most.

## 2. Decision

Silence becomes a tool call. A tool call is structured output the model is trained to produce on its own;
a magic word competes with the habit of always writing prose. Scanning the whole reply for the token is
rejected: it suppresses real replies that mention the token (#19537) and cannot tell which part was meant.

The token stays as a fallback for models without tool support and for older prompts. The tool is what the
prompt teaches whenever the model has tools.

## 3. The tool

- Name `no_reply`. Label "No reply". One optional parameter `reason` (string, max 200 chars): logged and kept
  in the transcript, never delivered.
- Description (model-facing, exact): "Stay silent: end this turn without sending a reply. Call it alone, as the
  first and only thing you do, when you have nothing to add. Anything you already sent with the message tool
  still goes out."
- Result: `{ "status": "silent" }`.

## 4. Behaviour

4.1 Calling `no_reply` ends the run the same way `sessions_yield` does (abort after the tool result, no
further model call). Reuse that path; do not build a second one. Run result carries `silent: true`.
4.2 Final reply payloads of that run are dropped: text, media, reply tags, everything the run would have
delivered at the end. Nothing is delivered and no "no response generated" or error notice is produced.
4.3 Sends already made through the `message` tool in that run are not affected.
4.4 Block streaming: blocks already delivered before the call cannot be recalled; blocks not yet flushed are
dropped. The prompt tells the model to call the tool first and alone (§6).
4.5 The typing indicator stops as for any finished run.
4.6 Heartbeat runs: `no_reply` counts as the heartbeat ack (same outcome as `HEARTBEAT_OK`).
4.7 If the model calls `no_reply` together with other tools in one message, the other tools run normally and
the run then ends silent (the tool order inside the message does not change the outcome).
4.8 The transcript keeps the tool call and result, so the next turn knows the agent chose silence.
4.9 Logging: one info line per silent run: session key, run id, reason (truncated), and whether any blocks
had already streamed.

## 5. When the tool is offered

5.1 Only in runs that have a reply target (inbound channel message, heartbeat, cron with delivery).
Not in subagent, swarm member or `agent --deliver=false` style runs without a target.
5.2 Not offered where the surface forbids silence: `surfaces.<channel>.silentReply.{group,direct}` = "disallow"
(existing setting, `src/config/silent-reply.ts`). There the prompt keeps saying nothing about silence.
5.3 Not offered when the model has no tool support (`supportsModelTools`); the token prompt is used instead.
5.4 New setting `agents.defaults.silentReply` (per agent: `agents.list[].silentReply`), values: - `"tool"` (default): offer the tool and teach it; the token is still honoured at runtime but not taught. - `"token"`: old behaviour, no tool.
Schema-validated, in the config docs and the generated schema.

## 6. Prompt

In `"tool"` mode the "Silent replies" section of `src/agents/system-prompt.ts` is replaced with (exact):

    ## Silent replies
    When you have nothing to say, call the `no_reply` tool and do nothing else.
    - Call it first and alone. Never write text and then call it.
    - Never write "NO_REPLY" as text.

The message-tool line that says "respond with ONLY: NO_REPLY" after a `message` send becomes "call `no_reply`".
Other places that teach the token to the model (heartbeat prompt text, group intro text) follow the same rule
in tool mode. Places where the runtime itself speaks the token to internal flows (subagent announce,
ANNOUNCE_SKIP and similar) are out of scope and unchanged.

## 7. Out of scope

- Removing token parsing. The fallback stays (`isSilentReplyText`, `stripSilentTokenEdges`).
- Recalling messages already streamed.
- Channel plugins: none change; suppression happens before dispatch.

## 8. Tests (all required)

1. Tool call ends the run: no second model call; run result `silent: true`.
2. Text written in the same assistant message before the call is not delivered.
3. Text from an earlier assistant message in the same run (before a tool round) is not delivered (non-streaming).
4. Media/reply payloads of the run are not delivered.
5. A `message` tool send earlier in the run is delivered.
6. Block streaming on: blocks flushed before the call stay sent, pending blocks are dropped.
7. Surface "disallow": tool absent from the tool list and prompt has no silence section.
8. Model without tools: token prompt, no tool, token still suppresses.
9. `silentReply: "token"`: old behaviour, no tool.
10. Heartbeat run: `no_reply` acts as the ack.
11. No error / empty-response notice on a silent run.
12. Runs without a reply target: tool absent.
13. Mixed tool message (`exec` + `no_reply`): exec runs, run ends silent.
14. Prompt snapshot for tool mode contains the exact §6 text.
15. Token fallback unchanged: existing `tokens.ts` tests still pass.

## 9. Acceptance (operator, after the build)

Live on a dev gateway, Signal group: model is told to stay quiet in a group -> it calls `no_reply`, nothing is
posted, transcript shows the call. Then asked a real question -> it answers normally. Then the same on a model
without tools -> token path.
