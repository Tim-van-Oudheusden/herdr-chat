# Recorded Pi RPC fixtures

Real `pi --mode rpc` sessions (Pi 1.5.0, `anthropic/claude-haiku-4-5`,
`--thinking low`), recorded by `record.ts` in a temp cwd with a temp
`--session-dir`. Extensions, skills, prompt templates, context files, MCP and
themes are off (`--no-extensions …`) to keep them small and stable; `dialog`
adds Pi's `examples/extensions/rpc-demo.ts`.

Each line is `{"t": ms, "dir": "in" | "out", "rec": {...}}`: `in` is what the
recorder sent, `out` is what Pi wrote. Home and temp paths are scrubbed to
`/home/user` and `/tmp/pi-fixture`, signatures to `"sig"`, and system
messages to a stub. `fake-pi` replays them (`FAKE_PI_REPLAY`, see
`tests/fake-pi/README.md`); `tests/host/fixtures.test.ts` drives each one
through the real host.

| Fixture | What it pins |
|---|---|
| `text-only` | thinking + text, usage in `get_session_stats` |
| `bash-read` | two tool calls run in parallel, interleaved updates, `structuredContent.exit_code` |
| `edit` | the edit tool's `details.patch` (unified) and `details.diff` |
| `steer` | `prompt` with `streamingBehavior: "steer"` during `sleep 3`: `queue_update`, then the user message after the tool |
| `abort` | a queued follow-up, `clear_queue`, then `abort` mid-bash: "Command aborted", then an empty assistant message with `stopReason: "error"` / "This operation was aborted", `agent_settled {aborted: true}`, and the `abort` reply last |
| `dialog` | `/rpc-input` (input dialog outside a run, `disposition: "handled"` only after the answer); a `select` from a `tool_call` hook **after** `tool_execution_start`; a blocked tool without `durationMs` |
| `resume` | `--session` on an existing session: `get_messages` history, then a new turn |

Re-record when Pi changes: `node tests/fixtures/record.ts [name …]`.

# Recorded omp RPC fixtures

`omp/`: real `omp --mode rpc` sessions (omp 19.1.1, `anthropic/claude-haiku-4-5`,
`--thinking low`), recorded by `omp/record.ts` in a temp cwd with a temp
`--session-dir` and `--no-extensions --no-skills --no-rules --no-context-files
--no-lsp --no-title` (`dialog` adds a demo extension the recorder writes). Each
recording starts with what the adapter sends at start (`negotiate_protocol`,
`set_event_filter` delta mode, `set_ask_dialog`, `get_state`, …), so a replay
can answer it. The line format and the scrubbing are the Pi fixtures' (paths to
`/home/user` and `/tmp/omp-fixture`, signatures to `"sig"`, the system prompt and
tool schemas dropped, a `credential_pin`'s account hash zeroed, the model list
cut to four). `rpc_chunk` runs are stored reassembled; fake-omp chunks them
again. `tests/host/omp-fixtures.test.ts` drives them through the real host;
`docs/dev/research/provider-omp.md` cites them for each wire difference.

| Fixture | What it pins |
|---|---|
| `text-only` | v2 negotiation, delta `message_update`s, `prompt` replied without `data`, `prompt_result` then `session_settled` |
| `tools` | bash and read in parallel; bash `details` (`trace`, `wallTimeMs`), read's hashline header and `displayContent` |
| `edit` | a hashline `edit {input}` and its numbered `details.diff` |
| `image` | a prompt with an image (echoed re-encoded as WebP) |
| `approval` | `--approval-mode always-ask`: the "Allow tool: bash" select, approved, then denied |
| `steer` | a steer while bash runs backgrounds it; the user message with `steering: true`; a queued follow-up; three `prompt_result`s |
| `abort` | a follow-up in omp's queue, `abort_and_restore_queue` (it comes back), `abort` |
| `queue` | two follow-ups, `remove_queued_message` takes the first back |
| `compact` | `manual_compaction_*` for a session too small, and the failed reply |
| `sessions` | `set_session_name` (no event), `get_entries`, `get_messages_page`, `fork` at the answer before a message, `new_session`, `switch_session`, `get_session_lease` |
| `dialog` | an extension's status and widget, a `select`, an `ask` dialog and a `form` (cancelled); each command's `prompt_result {agentInvoked: false}` after its dialog |
| `ask-tool` | in `--mode rpc` the `ask` tool isn't offered |
| `builtin` | `/session`: `command_output`, then the reply's `agentInvoked: false` |
| `error` | a provider error (bad API key): `stopReason: "error"`, `prompt_result {status: "error"}` |
| `resume` | `--resume <file>`: the history, then a new turn |

Re-record when omp changes: `node tests/fixtures/omp/record.ts [name …]`; `--rescrub` re-applies the scrubbing to the recorded files.

# Image fixtures

`images/`: one small real file per image format and header shape the host reads sizes from (`host/imagesize.ts`), for `tests/host/images.test.ts`. Each one's size and shape is in `images/make.py`, which writes them (needs Pillow): `python3 tests/fixtures/images/make.py`.
