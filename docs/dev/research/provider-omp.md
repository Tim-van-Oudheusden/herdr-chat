# omp as a provider (research, M0)

omp (oh-my-pi, `omp`) runs in the chat through `omp --mode rpc`
(`host/providers/omp/`). Its RPC grew from Pi's and keeps most command names,
but omp's own docs (`docs/rpc.md`, "Pi-compatible history/tree commands")
call it a dialect: some of Pi's commands aren't served, the run's lifecycle
frames differ, and session entries are OMP-native. So it is a sibling of the
Pi adapter that reuses Pi's code where the wire matches (`PiProcess`,
`assistantEnd`, the content helpers), not `pi.command = omp`.

Everything below was checked against **omp 19.1.1** (`omp --version` →
`omp/19.1.1`) by the recorder, `tests/fixtures/omp/record.ts`, with
`anthropic/claude-haiku-4-5` at thinking `low`, `--no-extensions --no-skills
--no-rules --no-context-files --no-lsp --no-title`, a temp cwd and
`--session-dir`. Each row names the fixture (`tests/fixtures/omp/<name>.jsonl`)
whose frames show it. `host/providers/omp/research/probe.mjs` is the quick
look (`--no-session`, one prompt, every record into `events.jsonl`).

## Transport

- omp writes `{"type":"ready","protocolVersion":1,"supportedProtocolVersions":[1,2],"maxFrameBytes":1048576,"maxReassembledFrameBytes":67108864,…}`
  first (every fixture, line 1).
- `negotiate_protocol {protocolVersion: 2}` → `{protocolVersion: 2}`. After
  it, an object over 1 MiB arrives as `rpc_chunk` frames. This is not
  hypothetical: `get_available_models` with a normal login is ~1.1 MB and came
  as 5 chunks (probe). Without v2 that reply fails. herdr-chat runs on Node
  without omp, so `frame.ts` ports the decoder (`ChunkDecoder`: one run at a
  time, index order, `byteLength` checked, strict UTF-8, 64 MiB cap).
  fake-omp re-chunks every frame over 16 KiB, so every replay runs it.
- `set_event_filter {events: null, messageUpdates: "delta"}` → echoed. In
  delta mode `message_update` drops the growing `partial` message: `*_start`
  carry the empty `block` (a tool call's `id` and `name`), `*_end` the whole
  `content` (`text-only`).

## Commands: what the Pi adapter sends, and what omp takes

| herdr-chat needs | Pi sends | omp 19.1.1 | Evidence |
|---|---|---|---|
| start | `pi --mode rpc [--session f]` | `omp --mode rpc [--resume <path>]`. **There is no `--session` flag**; `--resume` takes a path or an id prefix (a path follows the file's continuation, if it moved on to a sibling) | `omp --help`; `resume` |
| state | `get_state` | same name. Fields: `model` (the whole Model), `thinkingLevel`, `configuredThinkingLevel`, `thinkingLevels` (with `auto`), `sessionFile`, `sessionId`, `sessionName` (after a rename), `isStreaming`, `isCompacting`, `isSettled`, `hasPendingAsyncWork`, `messageCount`, `queuedMessageCount`, `queuedMessages {steering, followUp}`, `contextUsage` | every fixture |
| prompt | `prompt {message, images?, streamingBehavior?}` | same. The reply has **no `data`** when the prompt reaches the agent; `data: {agentInvoked: false}` when a builtin finished it at once. An extension command (`/pick`) replies with no data too, and its `prompt_result {agentInvoked: false}` comes after its dialog: the reply alone doesn't say whether a run starts | `text-only`, `builtin`, `dialog` |
| images | `images: [{type, data, mimeType}]` | identical. omp re-encodes it (the echo carries `image/webp`) | `image` |
| abort | `abort` | same | `abort` |
| take back the queue | `clear_queue` | **not served**. `abort_and_restore_queue` aborts and returns `{steering: [{text, images?}], followUp: [...]}`, answering after the abort is done (after `agent_end`) | `abort` |
| take back one | (clear and re-add) | `remove_queued_message {message, queue: "steering"\|"followUp"}` → `{removed}`, then a `queue_update` | `queue` |
| history | `get_messages` | same, and `get_messages_page {cursor?, limit?}` → `{messages, nextCursor?, totalMessages}` | `sessions`, `resume` |
| models | `get_available_models` | same, ~1.1 MB (every provider's catalog: chunked). `get_model_picker {limit}` → `rows` with `roles`, `current`, and `recent` (the picker's first rows) | `text-only`, probe |
| commands | `get_commands` | **`get_available_commands`** → `{name, source, description?, input.hint?, subcommands?}`. Sources seen: `builtin` (48), `skill` (27, named `skill:<name>`), `extension`, `custom`, `file`. Also pushed as `available_commands_update` at startup and after each session change | `text-only`, `sessions` |
| usage | `get_session_stats` | same; `contextUsage.percent` is a percentage (4.8 = 4.8 %), `cost` a number | `tools` |
| set model | `set_model {provider, modelId}` | same; answers the Model | |
| thinking | `set_thinking_level {level}` | same. Levels: `get_available_thinking_levels` → `{levels}` per model (Haiku 4.5: off…xhigh; Opus 5.5: off, low…max). `auto` (per turn) is accepted but not listed | `text-only`, probe |
| compact | `compact {customInstructions?}` | same. Progress is `manual_compaction_start/_end`; a session too small ends `{skipped: true, errorMessage: "Nothing to compact (session too small)"}` and the reply fails with that message | `compact` |
| new / switch | `new_session`, `switch_session {sessionPath}` | same, `{cancelled: false}` | `sessions` |
| rename | `set_session_name {name}` | same; **no event** follows (no `session_info_update`); `get_state.sessionName` has it, the file a `title_change` entry and its title slot | `sessions` |
| fork points | `get_fork_messages` | **not served**. `get_entries` → `{entries, leafId}`: every branch in append order, so the active branch is the `parentId` chain from `leafId` | `sessions` |
| fork | `fork {entryId}` | `fork {entryId?}` → `{cancelled}`; the new file **keeps** that entry (Pi's ends before it). To fork before a message, fork at the last message entry before it (an assistant answer: the entries in between are custom and `credential_pin` records); before the first message, `new_session {parentSession}` | `sessions` |
| dialogs | `extension_ui_response` | same, plus `answers` (an `ask`) and `data` (a `form`) | `dialog` |
| holder | (Pi's lock extension) | `get_session_lease {sessionIds}` → `{held, unknown}`; `omp session lease --json -- <id>` answers the same in ~60 ms without an RPC child | `sessions` |

## Events

| Pi event | omp 19.1.1 | Evidence |
|---|---|---|
| `agent_start`, `agent_end` | same; `agent_end` adds `isTerminal`, `yielded` | every run |
| `agent_settled` | **`session_settled`**, once the session is done (background jobs included), after the run's `prompt_result`s | `text-only`, `steer` |
| — | `prompt_result {id, agentInvoked, status: completed\|aborted\|error, sessionSettled, error?}` per prompt; a steer or follow-up that rode the run gets its own at the end (`steer`: three at once) | `steer`, `abort`, `error` |
| `message_start/_update/_end` | same, plus `messageId`. A user message carries `attribution: "user"` and, when steered in, `steering: true` | `steer` |
| `text_*`, `thinking_*`, `toolcall_*` | same (delta mode: see Transport) | `tools` |
| `tool_execution_start/_update/_end` | same. bash's `details`: `wallTimeMs`, `timeoutSeconds`, a large `trace`, `exitCode` only when non-zero. A read's text has omp's hashline header and line numbers (`[README.md#6BA2]\n1:# Fixture…`); `details.displayContent.text` is the plain text | `tools` |
| — | a steer while bash runs **backgrounds** the command ("Backgrounded early to handle an incoming message…", `details.async`), and `tool_execution_update`s for that call keep coming after its `tool_execution_end` | `steer` |
| `queue_update` | same `{steering, followUp}`, plus `liveSteered` | `steer`, `queue` |
| `compaction_start/_end` | `manual_compaction_*`, `auto_compaction_*` | `compact` |
| `auto_retry_start/_end` | same names (not recorded); plus `retry_fallback_applied/_succeeded` | rpc.md |
| `thinking_level_changed` | same, plus `model_changed` | rpc.md |
| `session_info_changed` | **`session_info_update`** is a builtin slash command's side channel only; a rename over RPC sends nothing | `sessions` |
| `extension_ui_request` | same methods, plus `ask`, `form`, `cancel {targetId}`, `open_url` | `dialog` |
| — | `command_output {text}` (a builtin's output, e.g. `/session`) | `builtin` |
| — | `advisor_cost_changed`, `available_commands_update`, and a `setWidget` for `autoresearch` without lines (a removal) after each run, even with `--no-extensions` | every fixture |
| provider error | the assistant message ends `stopReason: "error"`, `errorMessage`, `errorStatus`; `prompt_result {status: "error", error: {message, provider, model, retryable, httpStatus}}` | `error` |
| abort | the open bash ends `isError: true` with its output so far (no "Command aborted"); an empty assistant message `stopReason: "aborted"`, `errorMessage: "Interrupted by user"` | `abort` |

## Asks and approvals

- **Approvals** (`--approval-mode always-ask`): after the call's
  `tool_execution_start`, a `select` with `title: "Allow tool: bash\nCommand: echo approved"`
  and `options: ["Approve", "Approve bash for this session", "Deny"]`. Denied,
  the tool ends `isError: true`, "Tool call denied by user: bash"
  (`approval`). Ask and remember (`always-ask-cached`) adds "Approve File",
  "Always Approve File" and so on (omp `docs/approval-mode.md`).
- `ask` (an extension's `ui.askDialog`, after `set_ask_dialog {enabled: true}`):
  `questions: [{id, question, options: [{label, description?}], recommended?: <index>, multi?}]`,
  answered with `answers: [{id, selectedOptions, customInput?}]` in order (`dialog`).
- `form` (`ui.formDialog`) is sent in `--mode rpc` too, as `{html}`; a
  `{cancelled: true}` answer gives the extension `undefined` (`dialog`).

## Open questions, answered

1. **Does 19.1.1 match `docs/rpc.md` for every row?** Yes, with the
   differences above: no `--session` flag (`--resume`), a prompt's reply
   carries no `data` unless `agentInvoked` is false, a rename sends no event,
   `fork` keeps the entry it's given, `get_entries` holds every branch, a steer
   backgrounds a running bash, the models reply needs v2.
2. **How is an approval `select` recognized?** By its title, `Allow tool: <name>`
   then the details, and its options, an `Approve…` and a `Deny…`. The adapter
   (`approvalOf`) turns those into a permission card; any other select stays a
   plain select. So `permissions: true`. The approval mode is a start flag
   (`--approval-mode`, `tools.approvalMode`), with no RPC command to change it,
   so `permissionModes: []`.
3. **What does `--mode rpc` do when the model calls the `ask` tool?** It can't:
   the tool isn't offered in `--mode rpc` (`ask-tool`: the model lists its
   tools and finds no `ask`). Only `--mode rpc-ui` offers it, as a `form`.
4. **Is the `prompt` image shape Pi's?** Yes (`image`).
5. **Do `setStatus`/`setWidget` need `--no-ui` off?** They arrive in plain
   `--mode rpc` (`dialog`: the extension's status and widget at startup);
   `--no-ui` would drop them. `setTitle` needs `PI_RPC_EMIT_TITLE=1`.
6. **Is ChmaraX open to a fourth provider?** For Tim to ask.

## Sessions

- Files: `<agent dir>/sessions/<bucket>/<timestamp>_<id>.jsonl`. The agent dir:
  a named profile (`--profile`, `$OMP_PROFILE`, `$PI_PROFILE`) is
  `~/.omp/profiles/<name>/agent`; the default one `$PI_CODING_AGENT_DIR`, else
  `~/.omp/agent` (`~/<$PI_CONFIG_DIR>` for `.omp`). The bucket is the real cwd:
  `-<relative>` under home, `-tmp-<relative>` under the temp root, else
  `--<absolute>--`, separators as `-`. `--session-dir` and
  `$PI_CODING_AGENT_SESSION_DIR` hold them flat.
- A file starts with a 256-byte `{"type":"title",…}` slot (legacy files with the
  header), then `{"type":"session", id, cwd, …}`. `describe` takes the name from
  the slot, else the header's `title`.
- A skill invocation is no user message: it is one `custom_message`
  `skill-prompt` (live: a `custom` message) whose `details` hold `name`, `path`
  and `args`. The adapter shows it as the person's message with the skill's pill.
- Leases: a live omp holds `~/.omp/run/session-owners/<id>.lock` open while it
  owns the session. `sessionHolder` asks `omp session lease`, then `lsof` for
  the holder's pid. omp never corrupts a session two processes write (the
  second moves to a sibling), but the chat still refuses one a TUI holds.
- Continue as chat: omp's breadcrumb `<agent dir>/terminal-sessions/<tty>` (the
  TTY's path, `/dev/pts/3` → `pts-3`) has the cwd, then the session file, then
  optional `fresh` (no file yet) and `cwdstat` lines; the model and thinking are
  the file's last `model_change` (`model: "provider/id"`) and
  `thinking_level_change`.

## Tools

19.1.1's model-facing tools (`get_state.dumpTools`): `read`, `bash`, `edit`,
`eval`, `glob`, `grep`, `find`, `task`, `wait`, `todo`, `web_search`, `write`.
`edit` is a hashline patch, `{input: "[notes.txt#DA4B]\nPUT 1.=1:\n+I like banana pie."}`:
no `path`, no old/new strings. Its result's `details.diff` is numbered
(`-1|old`, `+1|new`, ` 4|context`; `-`/context carry the old line, `+` the new
one; a blank line between hunks), which `tools.ts` turns into a unified diff.

## Follow-ups (not in the first version)

- Render `form` requests (HTML forms) instead of cancelling them.
- Subagents: `set_subagent_subscription progress`, `subagent_progress` as the
  `task` card's progress; then subagent chats.
- `todo` as the chat's plan (`get_state.todoPhases`, the tool's results).
- The approval mode as a picker (it needs a restart with `--approval-mode`).
- A small omp extension that labels the terminal with its session (Continue as
  chat without a TTY) and writes the hand-off file (follow a session switch
  made in `/tui`), like Pi's lock extension.
- `/btw` side questions, goals, host tools, live voice and dictation.
- Which builtins need omp's own TUI (offered as `tuiCommands`); today every
  builtin is listed and sent over RPC.
- A fixture with a real compaction (a session big enough to compact).
