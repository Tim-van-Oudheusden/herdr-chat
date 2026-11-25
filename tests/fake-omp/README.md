# fake-omp

A stand-in for `omp --mode rpc`. Node, no dependencies. It speaks omp's RPC
(docs/dev/research/provider-omp.md): LF-framed JSONL, a `ready` frame first,
and after `negotiate_protocol` (v2) every object over `FAKE_OMP_FRAME_BYTES`
goes out as an `rpc_chunk` run, as omp sends one.

```sh
bin/herdr-chat-host serve --provider omp --omp tests/fake-omp/fake-omp.mjs --chat c-test --cwd /tmp/x --state-dir /tmp/s
```

Tests start it through `host.ts` (`ompHost({name, scenario | replay, speed, session, dir, env, frameBytes})`),
which reads back what the host sent (`ompCommands(type?)`). Its default frame
size is 16 KiB, so a replay's bigger records arrive chunked.

## Command line and environment

- `--version` prints `omp/19.1.1`.
- `session lease --json -- <id>…` prints `{held, unknown}`: held are the ids listed in the file `FAKE_OMP_HELD_FILE` (comma or line separated).
- Without `--mode rpc` it stands in for omp's TUI (a hand-off's `omp --resume <file>`): it prints its argv and waits for stdin to close.
- `--resume <file>` loads that session; `--session-dir <dir>` is where new ones go (default: `$PI_CODING_AGENT_DIR/sessions/<bucket>`, else a temp dir); `--no-session` keeps none; `--model provider/id`, `--thinking <level>` set the start state.
- `FAKE_OMP_REPLAY=<fixture.jsonl>`: replay a recorded session (below). Otherwise the scenario mode.
- `FAKE_OMP_SCENARIO=<file.json>`: the script. Without it every prompt gets `ok: <prompt>`.
- `FAKE_OMP_SPEED=<n>`: divides every wait.
- `FAKE_OMP_FRAME_BYTES=<n>`: the physical frame size (default 1 MiB, as omp).
- `FAKE_OMP_LOG=<file>`: every command received, one JSON per line, after a `{_start, pid, argv, env, cwd}` line.

## Replay mode

`FAKE_OMP_REPLAY=tests/fixtures/omp/<name>.jsonl` plays a session recorded from
real omp by `tests/fixtures/omp/record.ts`, the way fake-pi plays Pi's:

- Records before the first gating command play at start (the `ready` frame is fake-omp's own).
- Gating commands (`prompt`, `abort`, `abort_and_restore_queue`, `remove_queued_message`, `extension_ui_response`, `compact`, `new_session`, `switch_session`, `fork`, `set_model`, `set_thinking_level`, `set_session_name`): playback stops at each recorded one until the host sends one of the same type; its reply and its `prompt_result` carry the host's `id`.
- Other commands are answered at once from the recording: the latest recorded answer at the playback position.

## Scenario mode

Sessions persist as omp writes them: a 256-byte title slot, the header, then
entries with ids and `parentId`s (`model_change`, `thinking_level_change`,
`message`, `custom_message` for a skill, `title_change`). A restarted fake-omp
with `--resume` goes on with it.

- `prompt` while idle starts a run: `agent_start`, the user message (a `/skill:<name> args` prompt is a `skill-prompt` custom message instead), the script's steps, `agent_end`, a `prompt_result` per prompt the run took, `session_settled`. While a run is on it needs `streamingBehavior`: steers land between steps (echoed with `steering: true`), follow-ups after the script.
- `/session` is a builtin: `command_output`, then `{agentInvoked: false}`. `/pick` is an extension command: a select, a notify with the answer, then `prompt_result {agentInvoked: false}`.
- `abort`, `abort_and_restore_queue` (returns the queue), `remove_queued_message`, `get_state`, `get_messages`, `get_messages_page` (cursor = offset), `get_entries`, `fork` (keeps the entry; `session_busy` while running), `new_session`, `switch_session`, `set_session_name`, `set_model`, `set_thinking_level`, `compact` (a session under two messages is "Nothing to compact"), `get_available_models`/`_commands`/`_thinking_levels`, `get_model_picker`, `get_session_stats`, `get_session_lease`, `set_event_filter`, `set_ask_dialog`.

```jsonc
{
  "models": [Model, ...],        // get_available_models; three by default
  "model": "anthropic/claude-haiku-4-5",
  "thinkingLevel": "low",
  "commands": [{"name", "source", "description"}],  // get_available_commands
  "prompts": [{"match": "regex", "steps": [Step, ...]}],  // the first match answers
  "default": [Step, ...],        // else this, else `ok: <prompt>`
  "startup": [{"ui": {method, ...}}],  // extension_ui_requests at start (setStatus, setWidget, notify)
  "rejectPrompts": "regex",      // a matching prompt fails
  "compactMs": 150,
  "cost": 0.001
}
```

| Step | What it does |
|---|---|
| `{"text": "…", "thinking": "…"}` | one streamed assistant message (`{prompt}` in `text` is the prompt); `"error": "…"` ends it with `stopReason: "error"` |
| `{"tool": {name, args, output, isError, details, duration, approval}}` | an assistant tool call, then its run: `tool_execution_start`, with `approval: true` omp's "Allow tool" select first (Deny ends it "Tool call denied by user"), an update every 100 ms for `duration` ms (`tick N`), `tool_execution_end`, the `toolResult` message |
| `{"wait": ms}` | sleeps; an abort cuts it short |
