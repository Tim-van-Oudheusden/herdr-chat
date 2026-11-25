// Records real `omp --mode rpc` sessions as fixtures for fake-omp's replay mode.
//   node tests/fixtures/omp/record.ts [name ...]     (default: all)
// Real omp, anthropic/claude-haiku-4-5 (--thinking low), a temp cwd and --session-dir, short prompts.
// Output: tests/fixtures/omp/<name>.jsonl, lines {"t": ms, "dir": "in"|"out", "rec": {...}}, scrubbed.
// `rpc_chunk` runs are stored reassembled (fake-omp chunks them again when it replays).
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, realpathSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir, homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import { LineFramer } from "../../../host/framing.ts";
import { ChunkDecoder, isChunk } from "../../../host/providers/omp/frame.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const OMP = process.env.OMP_BIN ?? "omp";
const MODEL = process.env.OMP_FIXTURE_MODEL ?? "anthropic/claude-haiku-4-5";

type Rec = Record<string, any>;
type Line = { t: number; dir: "in" | "out"; rec: Rec };

// An extension for the dialog fixture: a select, an ask dialog, a form, a status and a widget.
const DEMO_EXT = `
export default function (pi) {
  pi.on("session_start", async (_e, ctx) => {
    ctx.ui.setStatus("demo", "Demo ready");
    ctx.ui.setWidget("demo", ["line one", "line two"]);
  });
  pi.registerCommand("pick", {
    description: "Pick a fruit (demo)",
    handler: async (_args, ctx) => {
      const v = await ctx.ui.select("Pick a fruit", ["apple", "banana"]);
      ctx.ui.notify("You picked: " + (v ?? "nothing"), "info");
    },
  });
  pi.registerCommand("quiz", {
    description: "Two questions (demo)",
    handler: async (_args, ctx) => {
      if (!ctx.ui.askDialog) return ctx.ui.notify("no askDialog here", "warning");
      const r = await ctx.ui.askDialog([
        { id: "db", question: "Which database?", options: [{ label: "Postgres" }, { label: "SQLite", description: "one file" }], recommended: 1 },
        { id: "features", question: "Which features?", options: [{ label: "Auth" }, { label: "Search" }], multi: true },
      ]);
      ctx.ui.notify("answers: " + JSON.stringify(r), "info");
    },
  });
  pi.registerCommand("survey", {
    description: "A form (demo)",
    handler: async (_args, ctx) => {
      if (!ctx.ui.formDialog) return ctx.ui.notify("no formDialog here", "warning");
      const r = await ctx.ui.formDialog('<form><label>Name <input type="text" name="name" value="Ada"></label></form>');
      ctx.ui.notify("form: " + JSON.stringify(r), "info");
    },
  });
}
`;

/** A tiny solid red PNG (8×8), for the image prompt. */
function redPng(): string {
  const crc = (buf: Buffer) => {
    let c = ~0;
    for (const b of buf) {
      c ^= b;
      for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
    }
    return ~c >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const w = 8, h = 8;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw.set([255, 0, 0], y * (w * 3 + 1) + 1 + x * 3);
  const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
  return png.toString("base64");
}

class Recording {
  lines: Line[] = [];
  t0 = Date.now();
  child;
  private n = 0;
  private listeners = new Set<(r: Rec) => void>();
  stderr = "";
  exited = false;
  ready: Promise<Rec>;

  constructor(cwd: string, sessionDir: string, extra: string[], env: Record<string, string> = {}) {
    const args = ["--mode", "rpc", "--model", MODEL, "--thinking", "low", "--session-dir", sessionDir,
      "--no-extensions", "--no-skills", "--no-rules", "--no-context-files", "--no-lsp", "--no-title", ...extra];
    this.child = spawn(OMP, args, { cwd, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, HERDR_CHAT_HOST: "1", ...env } });
    const f = new LineFramer(2 * 1024 * 1024);
    const chunks = new ChunkDecoder();
    f.onLine = (line) => {
      let rec = JSON.parse(line);
      if (isChunk(rec)) {
        const whole = chunks.push(rec);
        if (whole === null) return;
        rec = JSON.parse(whole);
      }
      this.lines.push({ t: Date.now() - this.t0, dir: "out", rec });
      for (const l of [...this.listeners]) l(rec);
    };
    this.ready = this.next((r) => r.type === "ready", 30_000, "ready");
    this.child.stdout.on("data", (d: Buffer) => f.push(d));
    this.child.stderr.on("data", (d: Buffer) => (this.stderr += d));
    this.child.on("exit", () => (this.exited = true));
  }

  send(cmd: Rec): string {
    const id = cmd.type === "extension_ui_response" ? cmd.id : `rec-${++this.n}`;
    const rec = cmd.type === "extension_ui_response" ? cmd : { id, ...cmd };
    this.lines.push({ t: Date.now() - this.t0, dir: "in", rec });
    this.child.stdin.write(JSON.stringify(rec) + "\n");
    return id;
  }

  next(pred: (r: Rec) => boolean, timeoutMs = 90_000, what = "record"): Promise<Rec> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.listeners.delete(l);
        reject(new Error(`timeout waiting for ${what}; stderr: ${this.stderr.slice(-800)}`));
      }, timeoutMs);
      const l = (r: Rec) => {
        if (pred(r)) {
          clearTimeout(timer);
          this.listeners.delete(l);
          resolve(r);
        }
      };
      this.listeners.add(l);
    });
  }

  async request(cmd: Rec, timeoutMs = 90_000): Promise<Rec> {
    const id = `rec-${this.n + 1}`;
    const p = this.next((r) => r.type === "response" && r.id === id, timeoutMs, `${cmd.type} response`);
    this.send(cmd);
    return p;
  }

  settled(timeoutMs = 120_000): Promise<Rec> {
    return this.next((r) => r.type === "session_settled", timeoutMs, "session_settled");
  }

  /** What the adapter sends at start, so a replay can answer each. */
  async startup(): Promise<Rec> {
    await this.ready;
    await this.request({ type: "negotiate_protocol", protocolVersion: 2 });
    await this.request({ type: "set_event_filter", events: null, messageUpdates: "delta" });
    await this.request({ type: "set_ask_dialog", enabled: true });
    const st = await this.request({ type: "get_state" });
    await this.request({ type: "get_available_thinking_levels" });
    await this.request({ type: "get_available_commands" });
    await this.request({ type: "get_session_stats" });
    await this.request({ type: "get_available_models" }, 120_000);
    await this.request({ type: "get_model_picker", limit: 40 });
    await this.request({ type: "get_messages" });
    return st.data;
  }

  async close(): Promise<void> {
    this.child.stdin.end();
    for (let i = 0; i < 200 && !this.exited; i++) await new Promise((r) => setTimeout(r, 50));
    if (!this.exited) this.child.kill("SIGKILL");
  }
}

function makeCwd(): { root: string; cwd: string; sessions: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "omp-fixture-")));
  const cwd = join(root, "cwd");
  const sessions = join(root, "sessions");
  mkdirSync(join(cwd, "src"), { recursive: true });
  writeFileSync(join(cwd, "README.md"), "# Fixture project\n\nA tiny project for recording omp.\n");
  writeFileSync(join(cwd, "notes.txt"), "I like apple pie.\n");
  writeFileSync(join(cwd, "src", "a.ts"), "export const a = 1; // TODO\n");
  writeFileSync(join(root, "demo-ext.ts"), DEMO_EXT);
  return { root, cwd, sessions };
}

function scrub(lines: Line[], root: string): Line[] {
  const home = homedir();
  const homes = [...new Set([home, realpathSync(home)])].sort((a, b) => b.length - a.length);
  const s = (v: string) => {
    let out = v.split(root).join("/tmp/omp-fixture");
    for (const h of homes) out = out.split(h).join("/home/user");
    return out;
  };
  const walk = (v: any, key?: string): any => {
    if (typeof v === "string") {
      if (key && /Signature$/.test(key)) return "sig";
      return s(v);
    }
    if (Array.isArray(v)) return v.map((x) => walk(x));
    if (v && typeof v === "object") {
      const out: any = {};
      for (const [k, x] of Object.entries(v)) {
        if (k === "systemPrompt") out[k] = ["(system prompt omitted)"];
        else if (k === "dumpTools") out[k] = (x as any[]).map((t: any) => ({ name: t.name }));
        // A credential_pin's pseudonymous account hash: linkable across sessions, so not kept.
        else if (k === "hash" && v.type === "credential_pin") out[k] = "0".repeat(64);
        else out[k] = walk(x, k);
      }
      return out;
    }
    return v;
  };
  return lines.map((l) => {
    let rec = walk(l.rec);
    if (rec.type === "response" && rec.command === "get_available_models" && Array.isArray(rec.data?.models)) {
      const keep = rec.data.models.filter((m: any) => m.provider === "anthropic").slice(0, 4);
      rec = { ...rec, data: { models: keep.map((m: any) => ({ provider: m.provider, id: m.id, name: m.name, reasoning: m.reasoning, contextWindow: m.contextWindow, input: m.input, thinking: m.thinking })) } };
    }
    if (rec.type === "response" && rec.command === "get_model_picker" && Array.isArray(rec.data?.rows)) {
      rec = { ...rec, data: { ...rec.data, rows: rec.data.rows.filter((r: any) => r.provider === "anthropic").slice(0, 4) } };
    }
    return { t: l.t, dir: l.dir, rec };
  });
}

function save(name: string, r: Recording, root: string): void {
  const path = join(HERE, `${name}.jsonl`);
  writeFileSync(path, scrub(r.lines, root).map((l) => JSON.stringify(l)).join("\n") + "\n");
  console.log(`wrote ${path} (${r.lines.length} records)`);
}

const pause = (ms: number) => new Promise((res) => setTimeout(res, ms));

/** One fixture: a fresh cwd, a recording, its save, the cleanup. */
async function record(name: string, extra: string[], body: (r: Recording, ctx: { root: string; cwd: string; sessions: string }) => Promise<void>, env: Record<string, string> = {}): Promise<void> {
  const ctx = makeCwd();
  const r = new Recording(ctx.cwd, ctx.sessions, extra.map((a) => a.replace("$ROOT", ctx.root)), env);
  try {
    await body(r, ctx);
  } finally {
    await r.close();
    save(name, r, ctx.root);
    rmSync(ctx.root, { recursive: true, force: true });
  }
}

const SCENARIOS: Record<string, () => Promise<void>> = {
  "text-only": () =>
    record("text-only", [], async (r) => {
      await r.startup();
      const s = r.settled();
      await r.request({ type: "prompt", message: "Reply with exactly: hello from omp" });
      await s;
      await r.request({ type: "get_session_stats" });
      await r.request({ type: "get_state" });
    }),
  image: () =>
    record("image", [], async (r) => {
      await r.startup();
      const s = r.settled();
      await r.request({ type: "prompt", message: "What colour is this image? Reply with one word.", images: [{ type: "image", data: redPng(), mimeType: "image/png" }] });
      await s;
    }),
  tools: () =>
    record("tools", [], async (r) => {
      await r.startup();
      const s = r.settled();
      await r.request({ type: "prompt", message: "Use the bash tool to run `ls`, then use the read tool on README.md, then reply with just the word done." });
      await s;
      await r.request({ type: "get_session_stats" });
    }),
  edit: () =>
    record("edit", [], async (r) => {
      await r.startup();
      const s = r.settled();
      await r.request({ type: "prompt", message: "Read notes.txt, then use the edit tool on it to replace the word apple with banana. Then reply with just the word done." });
      await s;
    }),
  approval: () =>
    record("approval", ["--approval-mode", "always-ask"], async (r) => {
      await r.startup();
      const answer = async (pick: RegExp) => {
        const d = await r.next((x) => x.type === "extension_ui_request" && x.method === "select", 90_000, "approval select");
        await pause(300);
        const value = (d.options as string[]).find((o) => pick.test(o)) ?? d.options[0];
        r.send({ type: "extension_ui_response", id: d.id, value });
      };
      let s = r.settled();
      await r.request({ type: "prompt", message: "Use the bash tool to run `echo approved`, then reply with its output." });
      await answer(/^Approve$/);
      await s;
      s = r.settled();
      await r.request({ type: "prompt", message: "Use the bash tool to run `echo second`. If it is denied, reply with just the word denied." });
      await answer(/^Deny/);
      await s;
    }),
  steer: () =>
    record("steer", [], async (r) => {
      await r.startup();
      const s = r.settled();
      const started = r.next((x) => x.type === "tool_execution_start", 90_000, "tool start");
      await r.request({ type: "prompt", message: "Use the bash tool to run `sleep 3 && echo slept`, then reply with its output." });
      await started;
      await pause(500);
      await r.request({ type: "prompt", message: "Also end your reply with the word steered.", streamingBehavior: "steer" });
      await r.request({ type: "prompt", message: "Then reply with just the word followed.", streamingBehavior: "followUp" });
      await s;
    }),
  // A steer makes omp background the running bash (it answers the steer at once), so the queued
  // message here is a follow-up: it stays queued until abort_and_restore_queue gives it back.
  abort: () =>
    record("abort", [], async (r) => {
      await r.startup();
      const started = r.next((x) => x.type === "tool_execution_start", 90_000, "tool start");
      const s = r.settled();
      await r.request({ type: "prompt", message: "Use the bash tool to run `for i in 1 2 3 4 5 6 7 8 9 10; do echo tick $i; sleep 1; done`." });
      await started;
      await pause(1500);
      await r.request({ type: "prompt", message: "Then say hi.", streamingBehavior: "followUp" });
      await pause(200);
      await r.request({ type: "abort_and_restore_queue" });
      await r.request({ type: "abort" });
      await Promise.race([s, pause(10_000)]);
      await r.request({ type: "get_state" });
    }),
  queue: () =>
    record("queue", [], async (r) => {
      await r.startup();
      const started = r.next((x) => x.type === "tool_execution_start", 90_000, "tool start");
      const s = r.settled();
      await r.request({ type: "prompt", message: "Use the bash tool to run `for i in 1 2 3 4; do echo tick $i; sleep 1; done`, then reply with just the word ticked." });
      await started;
      await pause(500);
      await r.request({ type: "prompt", message: "Reply with just the word first.", streamingBehavior: "followUp" });
      await r.request({ type: "prompt", message: "Reply with just the word second.", streamingBehavior: "followUp" });
      await pause(200);
      await r.request({ type: "remove_queued_message", message: "Reply with just the word first.", queue: "followUp" });
      await s;
    }),
  compact: () =>
    record("compact", [], async (r) => {
      await r.startup();
      let s = r.settled();
      await r.request({ type: "prompt", message: "Reply with exactly: first answer" });
      await s;
      s = r.settled();
      await r.request({ type: "prompt", message: "Reply with exactly: second answer" });
      await s;
      await r.request({ type: "compact", customInstructions: "Keep only the answers." }, 120_000);
      await r.request({ type: "get_session_stats" });
    }),
  sessions: () =>
    record("sessions", [], async (r) => {
      await r.startup();
      let s = r.settled();
      await r.request({ type: "prompt", message: "Reply with exactly: one" });
      await s;
      s = r.settled();
      await r.request({ type: "prompt", message: "Reply with exactly: two" });
      await s;
      await r.request({ type: "set_session_name", name: "Numbers" });
      const first = (await r.request({ type: "get_state" })).data;
      const entries = (await r.request({ type: "get_entries" })).data;
      await r.request({ type: "get_messages_page", limit: 2 });
      // The adapter forks before a user message: at the last message entry before it.
      const all = entries.entries as Rec[];
      const second = all.filter((e) => e.type === "message" && e.message?.role === "user")[1]!;
      const before = all.slice(0, all.indexOf(second)).reverse().find((e) => e.type === "message")!;
      // After each change, what the adapter and the core ask: the state, the levels, the history.
      const after = async () => {
        await r.request({ type: "get_state" });
        await r.request({ type: "get_available_thinking_levels" });
        await r.request({ type: "get_messages_page", limit: 100 });
      };
      await r.request({ type: "fork", entryId: before.id });
      await after();
      await r.request({ type: "get_messages" });
      await r.request({ type: "new_session" });
      await after();
      await r.request({ type: "switch_session", sessionPath: first.sessionFile });
      await after();
      await r.request({ type: "get_session_lease", sessionIds: [first.sessionId] });
    }),
  dialog: () =>
    record("dialog", ["-e", "$ROOT/demo-ext.ts"], async (r) => {
      await r.startup();
      // Each extension command is done at its prompt_result (the reply comes before its dialog).
      const done = (id: number) => r.next((x) => x.type === "prompt_result" && x.id === `rec-${id}`, 30_000, "prompt_result");
      // An extension select outside a run.
      const sel = r.next((x) => x.type === "extension_ui_request" && x.method === "select", 30_000, "select");
      const p1 = r.request({ type: "prompt", message: "/pick" });
      const d1 = done(11);
      const d = await sel;
      await pause(300);
      r.send({ type: "extension_ui_response", id: d.id, value: "banana" });
      await p1;
      await d1;
      // An ask dialog (set_ask_dialog is on).
      const ask = r.next((x) => x.type === "extension_ui_request" && (x.method === "ask" || x.method === "select"), 30_000, "ask");
      const p2 = r.request({ type: "prompt", message: "/quiz" });
      const d2 = done(12);
      const a = await ask;
      await pause(300);
      if (a.method === "ask") r.send({ type: "extension_ui_response", id: a.id, answers: [{ id: "db", selectedOptions: ["SQLite"] }, { id: "features", selectedOptions: ["Auth", "Search"] }] });
      else r.send({ type: "extension_ui_response", id: a.id, cancelled: true });
      await p2;
      await d2;
      // A form: no renderer, so cancel it.
      const form = r.next((x) => x.type === "extension_ui_request" && x.method === "form", 30_000, "form").catch(() => null);
      const p3 = r.request({ type: "prompt", message: "/survey" });
      const d3 = done(13);
      const f = await form;
      if (f) r.send({ type: "extension_ui_response", id: f.id, cancelled: true });
      await p3;
      await d3;
      await pause(500);
    }),
  "ask-tool": () =>
    record("ask-tool", [], async (r) => {
      await r.startup();
      const s = r.settled();
      await r.request({ type: "prompt", message: "Use the ask tool to ask me one question: which colour I prefer, red or blue. Then reply with my answer, or with just the word failed if the tool failed." });
      const d = await Promise.race([r.next((x) => x.type === "extension_ui_request" && ["select", "ask", "form", "input"].includes(x.method), 90_000, "ask ui"), s.then(() => null)]);
      if (d) r.send({ type: "extension_ui_response", id: d.id, cancelled: true });
      await s;
    }),
  error: () =>
    record("error", ["--api-key", "sk-ant-invalid-for-fixture"], async (r) => {
      await r.startup();
      const s = r.settled();
      await r.request({ type: "prompt", message: "Reply with exactly: hello" });
      await s;
    }),
  builtin: () =>
    record("builtin", [], async (r) => {
      await r.startup();
      await r.request({ type: "prompt", message: "/session" });
      await pause(1000);
    }),
  resume: async () => {
    const ctx = makeCwd();
    const first = new Recording(ctx.cwd, ctx.sessions, []);
    const st = await first.startup();
    const s1 = first.settled();
    await first.request({ type: "prompt", message: "Use the bash tool to run `echo kiwi`, then reply with just the word ok." });
    await s1;
    await first.close();
    const r = new Recording(ctx.cwd, ctx.sessions, ["--resume", st.sessionFile]);
    try {
      await r.startup();
      await r.request({ type: "get_messages_page", limit: 100 });
      const s = r.settled();
      await r.request({ type: "prompt", message: "What word did the command print? Reply with just that word." });
      await s;
    } finally {
      await r.close();
      save("resume", r, ctx.root);
      rmSync(ctx.root, { recursive: true, force: true });
    }
  },
};

// `--rescrub`: apply the current scrubbing to the fixtures already recorded (nothing is recorded).
const wanted = process.argv.slice(2);
if (wanted[0] === "--rescrub") {
  for (const f of readdirSync(HERE).filter((n) => n.endsWith(".jsonl"))) {
    const path = join(HERE, f);
    const lines: Line[] = readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    writeFileSync(path, scrub(lines, "/tmp/omp-fixture").map((l) => JSON.stringify(l)).join("\n") + "\n");
    console.log(`rescrubbed ${f}`);
  }
} else {
  for (const name of wanted.length ? wanted : Object.keys(SCENARIOS)) {
    const fn = SCENARIOS[name];
    if (!fn) throw new Error(`unknown fixture ${name}`);
    console.log(`recording ${name}…`);
    try {
      await fn();
    } catch (e) {
      console.error(`${name} failed: ${e instanceof Error ? e.message : e}`);
    }
  }
}
