// Recorded real omp 19.1.1 sessions (tests/fixtures/omp/*.jsonl), replayed by fake-omp through the real host.
// fake-omp re-chunks every frame over 16 KiB (protocol v2), so each replay also runs the chunk decoder.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { idle, ROOT } from "./harness.ts";
import { ompHost, OMP_FIXTURES } from "../fake-omp/host.ts";
import { readFileSync } from "node:fs";

const answered = (text: RegExp) => (x: any) => idle(x) && x.items.some((i: any) => i.kind === "assistant" && text.test(i.text) && !i.streaming);
const tools = (c: any) => c.items.filter((i: any) => i.kind === "tool");

test("omp fixture text-only: v2 negotiated, model, levels, thinking then the answer, usage", async () => {
  const h = await ompHost({ name: "omp-text", replay: "text-only.jsonl" });
  try {
    const c = h.client;
    await c.waitFor(idle, 10_000);
    assert.equal(c.state.provider, "omp");
    assert.equal(c.state.model.id, "claude-haiku-4-5");
    assert.equal(c.state.thinking, "low");
    assert.deepEqual(c.state.capabilities.thinkingLevels, ["off", "minimal", "low", "medium", "high", "xhigh", "auto"]);
    assert.equal(c.state.capabilities.permissions, true);
    assert.deepEqual(h.ompCommands().slice(1, 3).map((x) => x.type), ["negotiate_protocol", "set_event_filter"]);
    assert.equal((await c.req("send", { text: "Reply with exactly: hello from omp" })).disposition, "started");
    await c.waitFor(answered(/hello from omp/), 10_000);
    assert.deepEqual(c.items.map((i) => i.kind), ["user", "thinking", "assistant"]);
    assert.equal(c.items[0].source, "composer");
    assert.equal(c.items[2].stopReason, "stop");
    await c.waitFor((x) => x.state.usage?.contextTokens > 0, 3000, "usage after the turn");
    await h.waitStatus(/^done/);
    h.artifact("omp-fixture-text-only");
  } finally {
    await h.stop();
  }
});

test("omp fixture tools: bash and read in parallel; the read shows the file, not omp's hashline numbering", async () => {
  const h = await ompHost({ name: "omp-tools", replay: "tools.jsonl" });
  try {
    const c = h.client;
    await c.waitFor(idle, 10_000);
    await c.req("send", { text: "Use the bash tool to run `ls`, then use the read tool on README.md, then reply with just the word done." });
    await c.waitFor(answered(/done/i), 10_000);
    assert.deepEqual(tools(c).map((t: any) => [t.title, t.status]), [["$ ls", "done"], ["Read README.md", "done"]]);
    assert.equal(tools(c)[0].detail.exitCode, 0);
    assert.match(tools(c)[0].output, /README\.md\nnotes\.txt/);
    assert.equal(tools(c)[1].output, "# Fixture project\n\nA tiny project for recording omp.");
    h.artifact("omp-fixture-tools");
  } finally {
    await h.stop();
  }
});

test("omp fixture edit: a hashline edit's card is titled by its file and carries a unified diff", async () => {
  const h = await ompHost({ name: "omp-edit", replay: "edit.jsonl" });
  try {
    const c = h.client;
    await c.waitFor(idle, 10_000);
    await c.req("send", { text: "Read notes.txt, then use the edit tool on it to replace the word apple with banana. Then reply with just the word done." });
    await c.waitFor(answered(/done/i), 10_000);
    const edit = tools(c).find((t: any) => t.detail.type === "edit");
    assert.equal(edit.title, "Edit notes.txt");
    assert.equal(edit.status, "done");
    assert.match(edit.detail.diff, /^@@ -1,1 \+1,1 @@$/m);
    assert.match(edit.detail.diff, /^-I like apple pie\.$/m);
    assert.match(edit.detail.diff, /^\+I like banana pie\.$/m);
    h.artifact("omp-fixture-edit");
  } finally {
    await h.stop();
  }
});

test("omp fixture image: a prompt with an image; the echo carries it", async () => {
  const h = await ompHost({ name: "omp-image", replay: "image.jsonl" });
  try {
    const c = h.client;
    await c.waitFor(idle, 10_000);
    assert.equal(c.state.capabilities.images, true);
    await c.req("send", { text: "What colour is this image? Reply with one word.", images: [join(ROOT, "tests", "fixtures", "images", "fill.jpg")] });
    await c.waitFor(answered(/red/i), 10_000);
    const user = c.items.find((i) => i.kind === "user");
    assert.equal(user.images, 1);
    assert.equal(h.ompCommands("prompt")[0].images[0].type, "image");
    h.artifact("omp-fixture-image");
  } finally {
    await h.stop();
  }
});

test("omp fixture abort: abort mid-bash with a message in omp's queue: abort_and_restore_queue gives it back", async () => {
  const h = await ompHost({ name: "omp-abort", replay: "abort.jsonl", speed: 2 });
  try {
    const c = h.client;
    await c.waitFor(idle, 10_000);
    await c.req("send", { text: "Use the bash tool to run `for i in 1 2 3 4 5 6 7 8 9 10; do echo tick $i; sleep 1; done`." });
    await c.waitFor((x) => x.items.some((i) => i.kind === "tool" && i.status === "running"), 10_000, "running");
    // The recording queued a follow-up in omp here; the replay waits for a prompt before it plays on.
    await c.req("send", { text: "Then say hi.", mode: "steer" });
    await c.waitFor((x) => x.state.queue.followUp.length + x.state.queue.steering.length === 1, 5000, "queued in omp");
    const { restored } = await c.req("abort");
    assert.deepEqual(restored, ["Then say hi."]);
    await c.waitFor(idle, 10_000, "idle after abort");
    assert.deepEqual(h.ompCommands().filter((x) => /abort/.test(x.type)).map((x) => x.type), ["abort_and_restore_queue", "abort"]);
    const tool = tools(c)[0];
    assert.equal(tool.status, "error");
    assert.match(tool.output, /tick 2/);
    const last = c.items.filter((i) => i.kind === "assistant").at(-1);
    assert.equal(last.stopReason, "aborted");
    await h.waitStatus(/^idle$/);
    h.artifact("omp-fixture-abort");
  } finally {
    await h.stop();
  }
});

test("omp fixture error: a provider error ends the turn as an error, with omp's message", async () => {
  const h = await ompHost({ name: "omp-error", replay: "error.jsonl" });
  try {
    const c = h.client;
    await c.waitFor(idle, 10_000);
    await c.req("send", { text: "Reply with exactly: hello" });
    await c.waitFor((x) => idle(x) && x.items.some((i) => i.kind === "assistant" && i.stopReason === "error"), 10_000);
    const a = c.items.find((i) => i.kind === "assistant");
    assert.match(a.error, /authentication_error/);
    await h.waitStatus(/^error/);
    h.artifact("omp-fixture-error");
  } finally {
    await h.stop();
  }
});

test("omp fixture steer: a steer mid-bash is echoed as the person's message and answered in the same run", async () => {
  const h = await ompHost({ name: "omp-steer", replay: "steer.jsonl", speed: 2 });
  try {
    const c = h.client;
    await c.waitFor(idle, 10_000);
    await c.req("send", { text: "Use the bash tool to run `sleep 3 && echo slept`, then reply with its output." });
    await c.waitFor((x) => x.items.some((i) => i.kind === "tool" && i.status === "running"), 10_000, "tool running");
    assert.equal((await c.req("send", { text: "Also end your reply with the word steered." })).disposition, "queued");
    // The recording queued a follow-up in omp too.
    assert.equal((await c.req("send", { text: "Then reply with just the word followed.", mode: "steer" })).disposition, "queued");
    await c.waitFor(answered(/followed/i), 20_000);
    const users = c.items.filter((i) => i.kind === "user").map((i) => [i.text, i.source]);
    assert.deepEqual(users.map((u: any) => u[0]), ["Use the bash tool to run `sleep 3 && echo slept`, then reply with its output.", "Also end your reply with the word steered.", "Then reply with just the word followed."]);
    assert.ok(c.items.some((i) => i.kind === "assistant" && /steered/.test(i.text)));
    assert.deepEqual(c.state.queue.steering, []);
    h.artifact("omp-fixture-steer");
  } finally {
    await h.stop();
  }
});

test("omp fixture approval: omp's approval select is a permission card; allow runs the command, deny declines it", async () => {
  const h = await ompHost({ name: "omp-approval", replay: "approval.jsonl" });
  try {
    const c = h.client;
    await c.waitFor(idle, 10_000);
    await c.req("send", { text: "Use the bash tool to run `echo approved`, then reply with its output." });
    await c.waitFor((x) => x.state.dialog?.method === "permission", 10_000, "approval card");
    const d = c.state.dialog;
    assert.equal(d.title, "Allow bash?");
    assert.equal(d.message, "Command: echo approved");
    assert.deepEqual(d.choices.map((x: any) => [x.label, x.kind]), [["Allow once", "allow"], ["Approve bash for this session", "allow_always"], ["Deny", "deny"]]);
    assert.match(d.tool.title, /^\$ echo approved$/);
    await c.req("dialog_answer", { dialog: d.id, choice: "Approve" });
    await c.waitFor(answered(/approved/), 10_000);
    assert.equal(tools(c)[0].status, "done");

    await c.req("send", { text: "Use the bash tool to run `echo second`. If it is denied, reply with just the word denied." });
    await c.waitFor((x) => x.state.dialog?.method === "permission", 10_000, "second card");
    await c.req("dialog_answer", { dialog: c.state.dialog.id, choice: "Deny" });
    await c.waitFor(answered(/denied/i), 10_000);
    assert.equal(tools(c)[1].status, "error");
    assert.match(tools(c)[1].output, /denied by user/);
    const answers = h.ompCommands("extension_ui_response").map((x) => x.value);
    assert.deepEqual(answers, ["Approve", "Deny"]);
    h.artifact("omp-fixture-approval");
  } finally {
    await h.stop();
  }
});

test("omp fixture dialog: an extension select, an ask dialog as a questions card, a form cancelled with a notice", async () => {
  const h = await ompHost({ name: "omp-dialog", replay: "dialog.jsonl", speed: 2 });
  try {
    const c = h.client;
    await c.waitFor(idle, 10_000);
    await c.waitFor((x) => x.state.statuses.some((s: any) => s.key === "demo") && x.state.widgets.some((w: any) => w.key === "demo"), 5000, "status and widget");
    void c.req("send", { text: "/pick" });
    await c.waitFor((x) => x.state.dialog?.method === "select", 5000, "select");
    assert.equal(c.state.dialog.title, "Pick a fruit");
    await c.req("dialog_answer", { dialog: c.state.dialog.id, value: "banana" });
    await c.waitFor((x) => x.items.some((i) => i.kind === "notice" && i.text === "You picked: banana"), 5000, "notify");

    void c.req("send", { text: "/quiz" });
    await c.waitFor((x) => x.state.dialog?.method === "questions", 5000, "questions");
    const q = c.state.dialog;
    assert.deepEqual(q.questions.map((x: any) => [x.id, x.multiSelect, x.options.map((o: any) => o.label)]), [["db", false, ["Postgres", "SQLite"]], ["features", true, ["Auth", "Search"]]]);
    assert.equal(q.questions[0].options[1].recommended, true);
    await c.req("dialog_answer", { dialog: q.id, answers: { db: "SQLite", features: ["Auth", "Search"] } });
    await c.waitFor((x) => x.items.some((i) => i.kind === "notice" && /^answers: .*"SQLite"/.test(i.text)), 5000, "answers");
    assert.deepEqual(h.ompCommands("extension_ui_response").at(-1).answers, [{ id: "db", selectedOptions: ["SQLite"] }, { id: "features", selectedOptions: ["Auth", "Search"] }]);

    void c.req("send", { text: "/survey" });
    await c.waitFor((x) => x.items.some((i) => i.kind === "notice" && /asked for a form/.test(i.text)), 5000, "form notice");
    assert.equal(h.ompCommands("extension_ui_response").at(-1).cancelled, true);
    await c.waitFor((x) => idle(x) && x.items.some((i) => i.kind === "notice" && i.text === "form: undefined"), 5000);
    assert.equal(c.items.filter((i) => i.kind === "user").length, 0, "extension commands leave no message");
    h.artifact("omp-fixture-dialog");
  } finally {
    await h.stop();
  }
});

test("omp fixture builtin: /session runs in omp without a run; its output is a notice", async () => {
  const h = await ompHost({ name: "omp-builtin", replay: "builtin.jsonl" });
  try {
    const c = h.client;
    await c.waitFor(idle, 10_000);
    await c.waitFor((x) => x.state.commands.some((y: any) => y.name === "session" && y.source === "extension"), 3000, "omp's builtins listed");
    assert.ok(c.state.commands.some((y: any) => y.name === "model" && y.source === "builtin"), "the chat's /model, not omp's");
    assert.equal((await c.req("send", { text: "/session" })).disposition, "handled");
    await c.waitFor((x) => idle(x) && x.items.some((i) => i.kind === "notice" && /^Session: /.test(i.text)), 5000);
    assert.equal(c.items.filter((i) => i.kind === "user").length, 0);
    h.artifact("omp-fixture-builtin");
  } finally {
    await h.stop();
  }
});

test("omp fixture sessions: name, fork before the second message, new session, switch back", async () => {
  const h = await ompHost({ name: "omp-sessions", replay: "sessions.jsonl" });
  try {
    const c = h.client;
    await c.waitFor(idle, 10_000);
    await c.req("send", { text: "Reply with exactly: one" });
    await c.waitFor(answered(/^one$/), 10_000);
    await c.req("send", { text: "Reply with exactly: two" });
    await c.waitFor(answered(/^two$/), 10_000);
    await c.req("set_name", { name: "Numbers" });
    await c.waitFor((x) => x.state.sessionName === "Numbers", 3000);
    const first = c.state.sessionFile;
    const { points } = await c.req("fork_points", {});
    assert.deepEqual(points.map((p: any) => p.text), ["Reply with exactly: two", "Reply with exactly: one"]);
    const r = await c.req("fork", { point: points[0].id });
    assert.equal(r.text, "Reply with exactly: two");
    const fork = h.ompCommands("fork")[0];
    const recorded = readFileSync(join(OMP_FIXTURES, "sessions.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l).rec);
    const entries: any[] = recorded.find((r) => r.command === "get_entries").data.entries;
    const second = entries.filter((e) => e.type === "message" && e.message.role === "user")[1];
    const before = entries.slice(0, entries.indexOf(second)).reverse().find((e) => e.type === "message");
    assert.equal(before.message.role, "assistant");
    assert.equal(fork.entryId, before.id, "forked at the answer before that message");
    await c.waitFor((x) => x.state.sessionFile !== first && x.items.filter((i) => i.kind === "user").length === 1, 5000, "the fork's timeline");
    await c.req("new_session");
    await c.waitFor((x) => x.items.filter((i) => i.kind === "user").length === 0, 5000, "a new session");
    await c.req("switch_session", { path: first });
    await c.waitFor((x) => x.state.sessionFile === first, 5000, "back on the first");
    h.artifact("omp-fixture-sessions");
  } finally {
    await h.stop();
  }
});

test("omp fixture resume: --resume brings the history back (paged), then a new turn", async () => {
  const h = await ompHost({ name: "omp-resume", replay: "resume.jsonl", session: "/tmp/omp-fixture/sessions/recorded.jsonl" });
  try {
    const c = h.client;
    await c.waitFor((x) => idle(x) && x.items.some((i) => i.kind === "tool"), 10_000, "history");
    const hist = c.items.filter((i) => i.kind !== "thinking").map((i) => (i.kind === "tool" ? `tool:${i.title}:${i.status}` : i.kind));
    assert.deepEqual(hist, ["user", "tool:$ echo kiwi:done", "assistant"]);
    assert.ok(h.ompCommands("get_messages_page").length >= 1);
    assert.deepEqual(h.ompCommands("_start")[0].argv.slice(-2), ["--resume", "/tmp/omp-fixture/sessions/recorded.jsonl"]);
    await c.req("send", { text: "What word did the command print? Reply with just that word." });
    await c.waitFor(answered(/kiwi/i), 10_000);
    h.artifact("omp-fixture-resume");
  } finally {
    await h.stop();
  }
});

test("omp fixture compact: omp's skipped compaction is an error the chat reports", async () => {
  const h = await ompHost({ name: "omp-compact", replay: "compact.jsonl" });
  try {
    const c = h.client;
    await c.waitFor(idle, 10_000);
    await c.req("send", { text: "Reply with exactly: first answer" });
    await c.waitFor(answered(/first answer/), 10_000);
    await c.req("send", { text: "Reply with exactly: second answer" });
    await c.waitFor(answered(/second answer/), 10_000);
    await c.req("compact", { instructions: "Keep only the answers." });
    await c.waitFor((x) => x.items.some((i) => i.kind === "notice" && /Nothing to compact/.test(i.text)), 5000, "the failure");
    assert.equal(h.ompCommands("compact")[0].customInstructions, "Keep only the answers.");
    await c.waitFor(idle, 5000);
    h.artifact("omp-fixture-compact");
  } finally {
    await h.stop();
  }
});
