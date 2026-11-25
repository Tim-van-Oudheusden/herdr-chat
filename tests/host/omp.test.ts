// omp through the real host with fake-omp's scenario mode: what the recorded fixtures
// (omp-fixtures.test.ts) can't pin down: taking a steer back, skills, omp's own tool
// shapes, /resume over omp's session files, its session leases, the hand-off and
// Continue as chat by omp's terminal breadcrumb.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { idle, sleep, HOST_ENTRY, HOST_NODE } from "./harness.ts";
import { ompHost, FAKE_OMP } from "../fake-omp/host.ts";

const answered = (text: RegExp) => (x: any) => idle(x) && x.items.some((i: any) => i.kind === "assistant" && text.test(i.text) && !i.streaming);
const users = (c: any) => c.items.filter((i: any) => i.kind === "user").map((i: any) => i.text);
const jsonl = (rows: object[]) => rows.map((r) => JSON.stringify(r)).join("\n") + "\n";

/** An omp session file as omp writes it: the 256-byte title slot, the header, entries. */
function sessionFile(path: string, id: string, cwd: string, title: string | null, entries: object[]): string {
  const slot = (pad: string) => JSON.stringify({ type: "title", v: 1, title: title ?? "", source: "user", pad });
  writeFileSync(path, jsonl([JSON.parse(slot(" ".repeat(255 - Buffer.byteLength(slot(""))))), { type: "session", version: 3, id, timestamp: new Date().toISOString(), cwd }, ...entries]));
  return path;
}

test("omp queue: × on a steer takes it out of omp's queue (remove_queued_message); the run goes on without it", async () => {
  const h = await ompHost({
    name: "omp-queue",
    scenario: { prompts: [{ match: "^Run", steps: [{ tool: { name: "bash", args: { command: "sleep 2" }, duration: 1500 } }, { text: "ran" }] }] },
  });
  try {
    const c = h.client;
    await c.waitFor(idle, 10_000);
    await c.req("send", { text: "Run it" });
    await c.waitFor((x) => x.items.some((i) => i.kind === "tool" && i.status === "running"), 5000, "running");
    await c.req("send", { text: "never mind" });
    await c.req("send", { text: "keep this" });
    await c.waitFor((x) => x.state.queue.steering.length === 2, 3000, "two steers in omp's queue");
    assert.deepEqual(c.state.queue.steeringRemovable, [true, true]);
    await c.req("queue_remove", { message: c.state.queue.steeringIds[0] });
    await c.waitFor((x) => x.state.queue.steering.length === 1, 3000, "removed");
    assert.deepEqual(h.ompCommands("remove_queued_message").map((x) => [x.message, x.queue]), [["never mind", "steering"]]);
    await c.waitFor((x) => idle(x) && users(x).length === 2, 10_000, "run over");
    assert.deepEqual(users(c), ["Run it", "keep this"]);
    h.artifact("omp-queue-remove");
  } finally {
    await h.stop();
  }
});

test("omp skills: /skill:name is sent as typed, echoed as a skill pill, and forked from as typed", async () => {
  const h = await ompHost({ name: "omp-skill", scenario: { commands: [{ name: "skill:diagnose", source: "skill", description: "Diagnose a bug" }] } });
  try {
    const c = h.client;
    await c.waitFor(idle, 10_000);
    await c.waitFor((x) => x.state.commands.some((y: any) => y.name === "skill:diagnose" && y.source === "skill"), 3000, "the skill listed");
    await c.req("send", { text: "/skill:diagnose the crash" });
    await c.waitFor(answered(/ok:/), 5000);
    const u = c.items.find((i) => i.kind === "user");
    assert.equal(u.text, "the crash");
    assert.deepEqual(u.skills.map((s: any) => s.name), ["diagnose"]);
    assert.equal(h.ompCommands("prompt")[0].message, "/skill:diagnose the crash");
    const { points } = await c.req("fork_points", {});
    assert.deepEqual(points.map((p: any) => p.text), ["/skill:diagnose the crash"]);
    h.artifact("omp-skill");
  } finally {
    await h.stop();
  }
});

test("omp tools: hashline edits and writes, eval, glob, ast_grep and task get their own cards", async () => {
  const tool = (name: string, args: object, output = "", details?: object) => ({ tool: { name, args, output, ...(details ? { details } : {}) } });
  const h = await ompHost({
    name: "omp-tools",
    scenario: {
      default: [
        tool("edit", { input: "[src/a.ts#AB12]\nPUT 2.=3:\n+const b = 2;\n[src/b.ts#CD34]\nPUT 1.=1:\n+x" }, "[src/a.ts#EF56]", {
          diff: " 1|import x;\n-2|const a = 1;\n-3|const c = 3;\n+2|const b = 2;\n 4|export {};\n\n 9|// end\n+9|// more", path: "/proj/src/a.ts",
        }),
        tool("write", { path: "[notes.md#0000]", content: "hello\n" }),
        tool("eval", { language: "py", code: "print(1 + 1)\nprint(2)", title: "Add" }, "2"),
        tool("glob", { path: "src/**/*.ts" }),
        tool("ast_grep", { pat: "console.log($A)", path: "src" }),
        tool("task", { context: "ctx", tasks: [{ name: "Scout", task: "look" }, { name: "Fixer", task: "fix" }] }),
        { text: "done" },
      ],
    },
  });
  try {
    const c = h.client;
    await c.waitFor(idle, 10_000);
    await c.req("send", { text: "go" });
    await c.waitFor(answered(/done/), 10_000);
    const cards = c.items.filter((i) => i.kind === "tool");
    assert.deepEqual(cards.map((t) => t.title), ["Edit src/a.ts (+1)", "Write notes.md", "Eval (py) Add", "Find src/**/*.ts", "Find console.log($A) in src", "Task Scout, Fixer"]);
    const diff = cards[0].detail.diff;
    assert.match(diff, /^@@ -1,4 \+1,3 @@\n import x;\n-const a = 1;\n-const c = 3;\n\+const b = 2;\n export \{\};$/m);
    assert.match(diff, /^@@ -9,1 \+8,2 @@\n \/\/ end\n\+\/\/ more$/m);
    assert.equal(cards[2].detail.type, "bash");
    assert.equal(cards[2].detail.exitCode, 0);
    h.artifact("omp-tools");
  } finally {
    await h.stop();
  }
});

test("omp resume: /resume lists omp's sessions (title slot, legacy header-first files too); a restarted host rebuilds the timeline", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "pich-omp-resume-")));
  const cwd = join(dir, "cwd");
  mkdirSync(join(dir, "sessions"), { recursive: true });
  const legacy = join(dir, "sessions", "2026-01-01T00-00-00-000Z_legacy.jsonl");
  writeFileSync(legacy, jsonl([{ type: "session", version: 2, id: "legacy", timestamp: "2026-01-01T00:00:00.000Z", cwd, title: "Old one" }, { type: "message", id: "a", parentId: null, message: { role: "user", content: "from before" } }]));
  let file: string;
  const h1 = await ompHost({ name: "omp-resume", dir, cwd });
  try {
    const c = h1.client;
    await c.waitFor(idle, 10_000);
    await c.req("send", { text: "first" });
    await c.waitFor(answered(/ok: first/), 5000);
    await c.req("send", { text: "/skill:diagnose second" });
    await c.waitFor(answered(/ok: \/skill:diagnose second/), 5000);
    await c.req("set_name", { name: "Two things" });
    file = c.state.sessionFile;
    const { sessions } = await c.req("sessions", { refresh: true });
    const byPath = Object.fromEntries(sessions.map((s: any) => [s.path, s]));
    assert.deepEqual([byPath[file].name, byPath[file].firstMessage, byPath[file].messageCount, byPath[file].here], ["Two things", "first", 4, true]);
    assert.deepEqual([byPath[legacy].name, byPath[legacy].firstMessage], ["Old one", "from before"]);
  } finally {
    await h1.stop();
  }
  const h2 = await ompHost({ name: "omp-resume", dir, cwd, session: file });
  try {
    const c = h2.client;
    await c.waitFor((x) => idle(x) && users(x).length === 2, 10_000, "history");
    assert.deepEqual(users(c), ["first", "second"]);
    assert.deepEqual(c.items.find((i) => i.kind === "user" && i.text === "second").skills.map((s: any) => s.name), ["diagnose"]);
    assert.equal(c.state.sessionName, "Two things");
    h2.artifact("omp-resume");
  } finally {
    await h2.stop();
  }
});

test("omp conflict: a session a live omp holds (its lease) is refused with that omp's pid; resume once it lets go", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "pich-omp-cf-")));
  const home = join(dir, "home");
  const id = "01a20000-0000-7000-8000-00000000c0de";
  const lock = join(home, ".omp", "run", "session-owners", `${id}.lock`);
  mkdirSync(join(home, ".omp", "run", "session-owners"), { recursive: true });
  mkdirSync(join(dir, "sessions"), { recursive: true });
  writeFileSync(lock, "");
  const held = join(dir, "held.txt");
  writeFileSync(held, id);
  const file = sessionFile(join(dir, "sessions", `2026-01-01T00-00-00-000Z_${id}.jsonl`), id, join(dir, "cwd"), null, []);
  // The omp holding it: a process with the lease file open.
  const holder = spawn("tail", ["-f", lock], { stdio: "ignore" });
  await sleep(300);
  const h = await ompHost({ name: "omp-cf", dir, session: file, env: { HOME: home, FAKE_OMP_HELD_FILE: held } });
  try {
    const c = h.client;
    await c.waitFor((x) => x.state.phase === "conflict", 10_000);
    assert.deepEqual(c.state.conflict, { chat: null, terminal: null, pid: holder.pid });
    await assert.rejects(c.req("take_over"), /open in omp outside a chat \(pid \d+\)\. Quit it there, then use resume/);
    assert.equal(h.ompCommands("prompt").length, 0);
    holder.kill();
    writeFileSync(held, "");
    await c.req("resume");
    await c.waitFor(idle, 10_000);
    assert.equal(c.state.conflict, null);
    assert.equal(c.state.sessionFile, file);
    h.artifact("omp-conflict-lease");
  } finally {
    holder.kill();
    await h.stop();
  }
});

test("omp hand-off: /tui runs `omp --resume <session>`", async () => {
  const h = await ompHost({ name: "omp-tui" });
  try {
    const c = h.client;
    await c.waitFor(idle, 10_000);
    await c.req("send", { text: "hello" });
    await c.waitFor(answered(/ok: hello/), 5000);
    const file = c.state.sessionFile;
    const { argv } = await c.req("handoff");
    assert.deepEqual(argv, [FAKE_OMP, "--resume", file]);
    assert.equal(c.state.phase, "handoff");
    h.artifact("omp-handoff");
  } finally {
    await h.stop();
  }
});

test("omp tui-session: Continue as chat finds the TUI's session by its terminal's breadcrumb, with its model and thinking", { skip: process.platform !== "linux" || spawnSync("python3", ["--version"]).status !== 0 }, async () => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "herdr-chat-omp-tui-")));
  const agent = join(d, "agent");
  const cwd = join(d, "repo");
  mkdirSync(join(agent, "terminal-sessions"), { recursive: true });
  mkdirSync(cwd);
  const file = sessionFile(join(d, "s.jsonl"), "s1", cwd, null, [
    { type: "model_change", id: "1", parentId: null, model: "anthropic/claude-sonnet-5-5" },
    { type: "thinking_level_change", id: "2", parentId: "1", thinkingLevel: "high" },
  ]);
  // A process on a terminal of its own (a pty), standing in for the omp TUI.
  const py = spawn("python3", ["-c", "import pty; pty.spawn(['sleep', '30'])"], { stdio: ["pipe", "ignore", "ignore"] });
  try {
    let pid = 0;
    for (let i = 0; i < 50 && !pid; i++) {
      await sleep(100);
      pid = Number(spawnSync("pgrep", ["-P", String(py.pid)], { encoding: "utf8" }).stdout.trim().split("\n")[0]) || 0;
    }
    const tty = execFileSync("ps", ["-o", "tty=", "-p", String(pid)], { encoding: "utf8" }).trim();
    assert.match(tty, /^pts\//);
    const ask = (label?: string) => {
      const terminal = { pid, argv: ["/usr/local/bin/omp"], foreground: { pid, argv: ["/usr/local/bin/omp"] } };
      const r = spawnSync(HOST_NODE, [HOST_ENTRY, "tui-session", "--provider", "omp", "--terminal", JSON.stringify(terminal), "--cwd", cwd, ...(label ? ["--label", label] : [])],
        { encoding: "utf8", env: { ...process.env, PI_CODING_AGENT_DIR: agent } });
      return r.status === 0 ? { ok: JSON.parse(r.stdout) } : { error: r.stderr.trim() };
    };
    assert.match(ask().error!, /omp left no record of its session for terminal pts-\d+/);
    const crumb = join(agent, "terminal-sessions", tty.replace("/", "-"));
    writeFileSync(crumb, `${cwd}\n${join(d, "missing.jsonl")}\nfresh\n`);
    assert.match(ask().error!, /no messages yet/);
    writeFileSync(crumb, `${cwd}\n${file}\ncwdstat 1 2\n`);
    assert.deepEqual(ask().ok, { pid, group: null, session: file, model: "anthropic/claude-sonnet-5-5", thinking: "high", args: ["--model", "anthropic/claude-sonnet-5-5", "--thinking", "high"] });
    rmSync(crumb);
    assert.equal(ask(file).ok.session, file, "a label names the session too");
  } finally {
    py.kill();
  }
});
