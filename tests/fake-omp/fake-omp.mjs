#!/usr/bin/env node
// fake-omp: a stand-in for `omp --mode rpc`. No dependencies. See README.md.
// LF-framed JSONL on stdin/stdout; after `negotiate_protocol` (v2), objects
// over FAKE_OMP_FRAME_BYTES go out as `rpc_chunk` runs, as omp sends them.
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, openSync, writeSync, closeSync, realpathSync } from "node:fs";
import { randomUUID, randomBytes } from "node:crypto";
import { dirname, join, resolve, relative, isAbsolute } from "node:path";
import { tmpdir, homedir } from "node:os";

const VERSION = "19.1.1";
const argv = process.argv.slice(2);
if (argv.includes("--version") || argv.includes("-v")) {
  process.stdout.write(`omp/${VERSION}\n`);
  process.exit(0);
}
// `omp session lease --json -- <id>…`: the file FAKE_OMP_HELD_FILE lists the ids a live omp holds (comma or line separated).
if (argv[0] === "session" && argv[1] === "lease") {
  const ids = argv.slice(argv.indexOf("--") + 1);
  let listed = "";
  try {
    listed = process.env.FAKE_OMP_HELD_FILE ? readFileSync(process.env.FAKE_OMP_HELD_FILE, "utf8") : "";
  } catch {}
  const held = listed.split(/[,\s]+/).filter(Boolean);
  process.stdout.write(JSON.stringify({ held: ids.filter((i) => held.includes(i)), unknown: [] }) + "\n");
  process.exit(0);
}
if (!argv.includes("rpc")) {
  // The TUI (a hand-off's `omp --resume <file>`): say what it was given, then wait like a TUI until stdin closes.
  process.stdout.write(`fake-omp TUI ${JSON.stringify(argv)}\n`);
  process.stdin.on("end", () => process.exit(0));
  process.stdin.resume();
  setInterval(() => {}, 1 << 30);
} else main();

function flag(name) {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}

function main() {
  const SPEED = Number(process.env.FAKE_OMP_SPEED || "1") || 1;
  const FRAME = Number(process.env.FAKE_OMP_FRAME_BYTES || 1048576);
  const LOG = process.env.FAKE_OMP_LOG;
  const scaled = (ms) => Math.max(0, Math.round(ms / SPEED));
  const sleep = (ms) => new Promise((r) => setTimeout(r, scaled(ms)));
  let v2 = false;
  let chunkSeq = 0;

  function out(rec) {
    const json = JSON.stringify(rec);
    if (!v2 || Buffer.byteLength(json) + 1 <= FRAME) return void process.stdout.write(json + "\n");
    const bytes = Buffer.from(json, "utf8");
    const per = Math.max(1, Math.floor(((FRAME - 200) * 3) / 4));
    const count = Math.ceil(bytes.length / per);
    const chunkId = `rpc-${++chunkSeq}`;
    for (let i = 0; i < count; i++) {
      process.stdout.write(JSON.stringify({ type: "rpc_chunk", chunkId, index: i, count, byteLength: bytes.length, data: bytes.subarray(i * per, (i + 1) * per).toString("base64") }) + "\n");
    }
  }
  const respond = (id, command, data, error, code) =>
    out({ ...(id === undefined ? {} : { id }), type: "response", command, ...(error ? { success: false, error, ...(code ? { code } : {}) } : { success: true, ...(data !== undefined ? { data } : {}) }) });
  const log = (rec) => LOG && appendFileSync(LOG, JSON.stringify(rec) + "\n");
  log({ type: "_start", pid: process.pid, argv, env: { HERDR_CHAT_HOST: process.env.HERDR_CHAT_HOST ?? null }, cwd: process.cwd() });

  let onCommand = () => {};
  let buf = Buffer.alloc(0);
  process.stdin.on("data", (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    let i;
    while ((i = buf.indexOf(10)) >= 0) {
      const line = buf.subarray(0, i).toString("utf8").replace(/\r$/, "");
      buf = buf.subarray(i + 1);
      if (!line.trim()) continue;
      let rec;
      try {
        rec = JSON.parse(line);
      } catch (e) {
        respond(undefined, "parse", undefined, `Failed to parse command: ${e.message}`);
        continue;
      }
      log(rec);
      if (rec.type === "negotiate_protocol") {
        respond(rec.id, "negotiate_protocol", { protocolVersion: 2 });
        v2 = true;
        continue;
      }
      try {
        onCommand(rec);
      } catch (e) {
        respond(rec.id, rec.type, undefined, String(e?.message ?? e));
      }
    }
  });
  process.stdin.on("end", () => process.exit(0));
  setInterval(() => {}, 1 << 30);

  out({ type: "ready", protocolVersion: 1, supportedProtocolVersions: [1, 2], maxFrameBytes: FRAME, maxReassembledFrameBytes: 67108864, supportsBashExcludeFromContext: true });
  if (process.env.FAKE_OMP_REPLAY) replay(process.env.FAKE_OMP_REPLAY);
  else scenario();

  // ===================================================================== replay
  // Plays a recorded fixture (tests/fixtures/omp/*.jsonl, lines {t, dir, rec}). Gating commands
  // hold playback until the host sends one of the same type; queries are answered from the recording.
  function replay(path) {
    const lines = readFileSync(path, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
    const GATING = new Set(["prompt", "steer", "follow_up", "abort", "abort_and_restore_queue", "remove_queued_message", "extension_ui_response", "compact", "new_session", "switch_session", "fork", "set_model", "set_thinking_level", "set_session_name"]);
    const recorderIds = new Set(lines.filter((l) => l.dir === "in" && l.rec.id !== undefined).map((l) => String(l.rec.id)));
    const answers = new Map();
    lines.forEach((l, i) => {
      if (l.dir !== "in" || GATING.has(l.rec.type) || l.rec.type === "negotiate_protocol") return;
      const resp = lines.slice(i + 1).find((x) => x.dir === "out" && x.rec.type === "response" && x.rec.id === l.rec.id);
      if (!resp) return;
      if (!answers.has(l.rec.type)) answers.set(l.rec.type, []);
      answers.get(l.rec.type).push({ at: i, rec: resp.rec });
    });
    const isQueryResponse = (rec) => rec.type === "response" && rec.id !== undefined && recorderIds.has(String(rec.id)) && !GATING.has(rec.command);
    let pos = 0;
    let playing = false;
    const waiting = [];
    const idMap = new Map();
    async function play() {
      if (playing) return;
      playing = true;
      let lastT = null;
      while (pos < lines.length) {
        const l = lines[pos];
        if (l.dir === "in") {
          if (!GATING.has(l.rec.type)) {
            pos++;
            continue;
          }
          const wi = waiting.findIndex((w) => w.type === l.rec.type);
          if (wi < 0) break;
          const w = waiting.splice(wi, 1)[0];
          if (l.rec.id !== undefined) idMap.set(String(l.rec.id), w.id);
          pos++;
          lastT = l.t;
          continue;
        }
        if (lastT !== null && l.t > lastT) await sleep(l.t - lastT);
        lastT = l.t;
        pos++;
        const rec = l.rec;
        if (rec.type === "ready" || isQueryResponse(rec) || (rec.type === "response" && rec.command === "negotiate_protocol")) continue;
        if ((rec.type === "response" || rec.type === "prompt_result") && rec.id !== undefined) {
          const hostId = idMap.get(String(rec.id));
          out({ ...rec, ...(hostId === undefined ? {} : { id: hostId }) });
          continue;
        }
        out(rec);
      }
      playing = false;
    }
    onCommand = (rec) => {
      if (GATING.has(rec.type)) {
        waiting.push({ type: rec.type, id: rec.id });
        play();
        return;
      }
      const list = answers.get(rec.type);
      if (!list?.length) return respond(rec.id, rec.type, undefined, `fake-omp replay: no recorded ${rec.type}`);
      let pick = list[0];
      for (const a of list) if (a.at <= pos) pick = a;
      out({ ...pick.rec, id: rec.id });
    };
    play();
  }

  // ===================================================================== scenario
  // A scripted omp: every prompt is answered by the first matching `prompts` script, else `default`,
  // else "ok: <prompt>". Sessions persist as omp writes them (a title slot, the header, entries).
  function scenario() {
    const sc = process.env.FAKE_OMP_SCENARIO ? JSON.parse(readFileSync(process.env.FAKE_OMP_SCENARIO, "utf8")) : {};
    const MODELS = sc.models ?? [
      { provider: "anthropic", id: "claude-haiku-4-5", name: "Claude Haiku 4.5", reasoning: true, contextWindow: 200000, input: ["text", "image"] },
      { provider: "anthropic", id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", reasoning: true, contextWindow: 1000000, input: ["text", "image"] },
      { provider: "local", id: "tiny", name: "Tiny", reasoning: false, contextWindow: 8000, input: ["text"] },
    ];
    const COMMANDS = sc.commands ?? [
      { name: "session", source: "builtin", description: "Show session info" },
      { name: "pick", source: "extension", description: "Pick a fruit (demo)" },
      { name: "review", source: "file", description: "Review the diff" },
      { name: "skill:diagnose", source: "skill", description: "Diagnose a bug" },
    ];
    const LEVELS = (m) => (m.reasoning ? ["off", "minimal", "low", "medium", "high", "xhigh"] : ["off"]);
    let model = MODELS.find((m) => `${m.provider}/${m.id}` === (flag("--model") ?? sc.model)) ?? MODELS[0];
    let thinking = flag("--thinking") ?? sc.thinkingLevel ?? "low";
    const cwd = process.cwd();
    const sessionDir = () => {
      const d = flag("--session-dir");
      if (d) return resolve(cwd, d);
      const root = process.env.PI_CODING_AGENT_DIR ?? join(tmpdir(), "fake-omp-agent");
      const real = realpathSync(cwd);
      const rel = relative(realpathSync(homedir()), real);
      return join(root, "sessions", !rel.startsWith("..") && !isAbsolute(rel) ? `-${rel.replace(/\//g, "-")}` : `--${real.slice(1).replace(/\//g, "-")}--`);
    };
    const noSession = argv.includes("--no-session");
    // The session: file, id, title, entries (with ids and parentIds), leaf.
    let s = null;
    const newId = () => randomBytes(4).toString("hex");
    function titleSlot(title) {
      const line = JSON.stringify({ type: "title", v: 1, title: title ?? "", source: "user", pad: "" });
      return JSON.stringify({ type: "title", v: 1, title: title ?? "", source: "user", pad: " ".repeat(Math.max(0, 255 - Buffer.byteLength(line))) });
    }
    function persist() {
      if (!s?.file) return;
      mkdirSync(dirname(s.file), { recursive: true });
      const header = { type: "session", version: 3, id: s.id, timestamp: new Date(s.created).toISOString(), cwd, ...(s.parent ? { parentSession: s.parent } : {}) };
      writeFileSync(s.file, [titleSlot(s.title), JSON.stringify(header), ...s.entries.map((e) => JSON.stringify(e))].join("\n") + "\n");
    }
    function fresh(parent) {
      const id = randomUUID();
      const created = Date.now();
      s = { id, created, title: null, entries: [], leaf: null, parent, file: noSession ? null : join(sessionDir(), `${new Date(created).toISOString().replace(/[:.]/g, "-")}_${id}.jsonl`) };
      append({ type: "model_change", model: `${model.provider}/${model.id}` });
      append({ type: "thinking_level_change", thinkingLevel: thinking });
    }
    function load(file) {
      const lines = readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
      const title = lines.find((l) => l.type === "title")?.title || null;
      const header = lines.find((l) => l.type === "session");
      const entries = lines.filter((l) => l.type !== "title" && l.type !== "session");
      s = { id: header.id, created: Date.parse(header.timestamp), title, entries, leaf: entries.at(-1)?.id ?? null, parent: header.parentSession, file };
    }
    function append(e) {
      const entry = { ...e, id: newId(), parentId: s.leaf, timestamp: new Date().toISOString() };
      s.entries.push(entry);
      s.leaf = entry.id;
      persist();
      return entry;
    }
    const branch = () => {
      const byId = new Map(s.entries.map((e) => [e.id, e]));
      const path = [];
      for (let e = byId.get(s.leaf); e; e = byId.get(e.parentId)) path.unshift(e);
      return path;
    };
    const messages = () => branch().filter((e) => e.type === "message" || (e.type === "custom_message" && e.display !== false)).map((e) => (e.type === "message" ? e.message : { role: "custom", customType: e.customType, content: e.content, display: true, details: e.details, attribution: "user", timestamp: Date.parse(e.timestamp) }));
    const resumeArg = flag("--resume");
    if (resumeArg && existsSync(resumeArg)) load(resumeArg);
    else fresh();

    let running = null; // { aborted, wake }
    let queue = { steering: [], followUp: [] };
    const asks = new Map();
    let msgSeq = 0;
    const state = () => ({
      model, thinkingLevel: thinking, configuredThinkingLevel: thinking, thinkingLevels: ["off", "auto", ...LEVELS(model).slice(1)],
      isStreaming: !!running, isCompacting: false, steeringMode: "one-at-a-time", followUpMode: "one-at-a-time", interruptMode: "immediate",
      ...(s.file ? { sessionFile: s.file } : {}), sessionId: s.id, ...(s.title ? { sessionName: s.title } : {}),
      autoCompactionEnabled: true, messageCount: messages().length, queuedMessageCount: queue.steering.length + queue.followUp.length,
      hasPendingAsyncWork: false, isSettled: !running, queuedMessages: queue,
    });
    const lastUsage = () => [...messages()].reverse().find((m) => m.role === "assistant")?.usage;
    const queueUpdate = () => out({ type: "queue_update", steering: queue.steering.map((q) => q.text), followUp: queue.followUp.map((q) => q.text), liveSteered: 0 });

    function dialog(req) {
      const id = randomBytes(8).toString("hex");
      out({ type: "extension_ui_request", id, ...req });
      return new Promise((r) => asks.set(id, r));
    }
    const abortable = (ms) => new Promise((r) => {
      const t = setTimeout(r, scaled(ms));
      if (running) running.wake = () => (clearTimeout(t), r());
    });

    async function assistant(content, extra = {}) {
      const messageId = `msg-${++msgSeq}`;
      const msg = { role: "assistant", content: [], api: "anthropic-messages", provider: model.provider, model: model.id, stopReason: "stop", timestamp: Date.now() };
      out({ type: "message_start", message: msg, messageId });
      for (const [i, b] of content.entries()) {
        if (running?.aborted) break;
        const kind = b.type === "toolCall" ? "toolcall" : b.type;
        if (kind === "toolcall") {
          out({ type: "message_update", assistantMessageEvent: { type: "toolcall_start", contentIndex: i, block: { type: "toolCall", id: b.id, name: b.name, arguments: {} } }, message: { role: "assistant" }, messageId });
          out({ type: "message_update", assistantMessageEvent: { type: "toolcall_end", contentIndex: i, toolCall: b }, message: { role: "assistant" }, messageId });
        } else {
          const text = b.text ?? b.thinking;
          out({ type: "message_update", assistantMessageEvent: { type: `${kind}_start`, contentIndex: i, block: { type: kind, [kind === "text" ? "text" : "thinking"]: "" } }, message: { role: "assistant" }, messageId });
          for (let k = 0; k < text.length; k += 12) {
            out({ type: "message_update", assistantMessageEvent: { type: `${kind}_delta`, contentIndex: i, delta: text.slice(k, k + 12) }, message: { role: "assistant" }, messageId });
            await abortable(10);
            if (running?.aborted) break;
          }
          out({ type: "message_update", assistantMessageEvent: { type: `${kind}_end`, contentIndex: i, content: text, block: { type: kind } }, message: { role: "assistant" }, messageId });
        }
        msg.content.push(b);
      }
      const tokens = 9000 + messages().length * 100;
      const final = { ...msg, ...extra, ...(running?.aborted ? { stopReason: "aborted", errorMessage: "Interrupted by user" } : {}), usage: { input: 10, output: 20, cacheRead: tokens, cacheWrite: 0, totalTokens: tokens + 30, cost: { total: sc.cost ?? 0.001 } } };
      out({ type: "message_end", message: final, messageId });
      append({ type: "message", message: final });
      return final;
    }

    async function tool(step) {
      const id = `toolu_${randomBytes(6).toString("hex")}`;
      const call = { type: "toolCall", id, name: step.name, arguments: step.args ?? {} };
      await assistant([call], { stopReason: "toolUse" });
      if (running?.aborted) return;
      out({ type: "tool_execution_start", toolCallId: id, toolName: step.name, args: call.arguments });
      let denied = false;
      if (step.approval) {
        const detail = step.name === "bash" ? `Command: ${call.arguments.command}` : JSON.stringify(call.arguments);
        const answer = await dialog({ method: "select", title: `Allow tool: ${step.name}\n${detail}`, options: ["Approve", `Approve ${step.name} for this session`, "Deny"] });
        denied = !answer?.value || answer.value === "Deny";
      }
      let isError = denied || step.isError === true;
      let text = denied ? `Tool call denied by user: ${step.name}` : step.output ?? "";
      if (!denied && step.duration) {
        for (let t = 0; t < step.duration && !running?.aborted; t += 100) {
          out({ type: "tool_execution_update", toolCallId: id, toolName: step.name, args: call.arguments, partialResult: { content: [{ type: "text", text: `${text}tick ${t / 100 + 1}\n` }], details: {} } });
          text = `${text}tick ${t / 100 + 1}\n`;
          await abortable(100);
        }
        if (running?.aborted) isError = true;
      }
      const result = { content: [{ type: "text", text }], details: step.details ?? {} };
      out({ type: "tool_execution_end", toolCallId: id, toolName: step.name, result, isError });
      const tr = { role: "toolResult", toolCallId: id, toolName: step.name, content: result.content, details: result.details, isError, timestamp: Date.now() };
      out({ type: "message_start", message: tr, messageId: `msg-${++msgSeq}` });
      out({ type: "message_end", message: tr, messageId: `msg-${msgSeq}` });
      append({ type: "message", message: tr });
    }

    function userEcho(text, images, steering) {
      const skill = /^\/skill:(\S+)\s*([\s\S]*)$/.exec(text);
      const messageId = `msg-${++msgSeq}`;
      if (skill) {
        const m = { role: "custom", customType: "skill-prompt", content: `[IMPORTANT: User invoked the "${skill[1]}" skill]\nUser: ${skill[2]}`, display: true, details: { name: skill[1], path: `/skills/${skill[1]}/SKILL.md`, args: skill[2], prompt: text }, attribution: "user", timestamp: Date.now() };
        out({ type: "message_start", message: m, messageId });
        out({ type: "message_end", message: m, messageId });
        append({ type: "custom_message", customType: "skill-prompt", content: m.content, display: true, details: m.details, attribution: "user" });
        return;
      }
      const m = { role: "user", content: [{ type: "text", text }, ...(images ?? [])], attribution: "user", ...(steering ? { steering: true } : {}), timestamp: Date.now() };
      out({ type: "message_start", message: m, messageId });
      out({ type: "message_end", message: m, messageId });
      append({ type: "message", message: m });
    }

    async function steps(list, text) {
      for (const st of list) {
        if (running?.aborted) return;
        if (st.wait) await abortable(st.wait);
        else if (st.tool) await tool(st.tool);
        else if (st.text !== undefined || st.thinking !== undefined) {
          const content = [...(st.thinking ? [{ type: "thinking", thinking: st.thinking }] : []), ...(st.text !== undefined ? [{ type: "text", text: st.text.replace("{prompt}", text) }] : [])];
          await assistant(content, st.error ? { stopReason: "error", errorMessage: st.error } : {});
        }
        // Steering lands between steps.
        while (queue.steering.length && !running?.aborted) {
          const q = queue.steering.shift();
          queueUpdate();
          userEcho(q.text, q.images, true);
          await steps(script(q.text), q.text);
        }
      }
    }
    const script = (text) => (sc.prompts ?? []).find((p) => new RegExp(p.match).test(text))?.steps ?? sc.default ?? [{ text: "ok: {prompt}" }];

    async function run(first) {
      running = { aborted: false, wake: null, ids: [first.id] };
      out({ type: "agent_start" });
      let next = first;
      while (next) {
        out({ type: "turn_start" });
        userEcho(next.text, next.images, false);
        await steps(script(next.text), next.text);
        out({ type: "turn_end" });
        next = running.aborted ? null : queue.followUp.shift();
        if (next) {
          running.ids.push(next.id);
          queueUpdate();
        }
      }
      const status = running.aborted ? "aborted" : "completed";
      out({ type: "agent_end", messages: [], isTerminal: true, yielded: true });
      for (const id of running.ids) out({ type: "prompt_result", id, agentInvoked: true, status, sessionSettled: true });
      running = null;
      out({ type: "session_settled" });
    }

    function doAbort() {
      if (!running) return;
      running.aborted = true;
      running.wake?.();
      for (const [id, r] of asks) {
        asks.delete(id);
        out({ type: "extension_ui_request", id: randomBytes(8).toString("hex"), method: "cancel", targetId: id });
        r(undefined);
      }
    }

    async function startup() {
      for (const st of sc.startup ?? []) {
        if (st.ui) out({ type: "extension_ui_request", id: randomBytes(8).toString("hex"), ...st.ui });
      }
      out({ type: "available_commands_update", commands: COMMANDS });
    }
    startup();

    onCommand = async (rec) => {
      const ok = (data) => respond(rec.id, rec.type, data);
      const fail = (error, code) => respond(rec.id, rec.type, undefined, error, code);
      switch (rec.type) {
        case "set_event_filter":
          return ok({ events: rec.events ?? null, messageUpdates: rec.messageUpdates ?? "full" });
        case "set_ask_dialog":
          return ok({ enabled: rec.enabled === true });
        case "get_state":
          return ok(state());
        case "get_available_thinking_levels":
          return ok({ levels: LEVELS(model) });
        case "get_available_commands":
          return ok({ commands: COMMANDS });
        case "get_available_models":
          return ok({ models: MODELS });
        case "get_model_picker":
          return ok({ rows: MODELS.map((m) => ({ provider: m.provider, id: m.id, name: m.name, roles: m === model ? [{ role: "default" }] : [], current: m === model })), recent: 1, total: MODELS.length });
        case "get_session_stats": {
          const u = lastUsage();
          const tokens = u ? u.input + u.output + u.cacheRead : null;
          return ok({ sessionFile: s.file, sessionId: s.id, cost: sc.cost ?? 0.001, contextUsage: tokens === null ? undefined : { tokens, contextWindow: model.contextWindow, percent: (tokens / model.contextWindow) * 100 } });
        }
        case "get_messages":
          return ok({ messages: messages() });
        case "get_messages_page": {
          const all = messages();
          const from = rec.cursor ? Number(rec.cursor) : 0;
          const limit = rec.limit ?? 100;
          return ok({ messages: all.slice(from, from + limit), totalMessages: all.length, ...(from + limit < all.length ? { nextCursor: String(from + limit) } : {}) });
        }
        case "get_entries":
          return ok({ entries: s.entries, leafId: s.leaf });
        case "get_session_lease":
          return ok({ held: [], unknown: [] });
        case "prompt": {
          const text = String(rec.message ?? "");
          if (sc.rejectPrompts && new RegExp(sc.rejectPrompts).test(text)) return fail(`Rejected: ${text}`);
          const entry = { id: rec.id, text, images: rec.images };
          if (/^\/session\b/.test(text)) {
            out({ type: "command_output", text: `Session: ${s.id}\nCWD: ${cwd}` });
            return ok({ agentInvoked: false });
          }
          if (/^\/pick\b/.test(text)) {
            ok();
            const a = await dialog({ method: "select", title: "Pick a fruit", options: ["apple", "banana"] });
            out({ type: "extension_ui_request", id: randomBytes(8).toString("hex"), method: "notify", message: `You picked: ${a?.value ?? "nothing"}`, notifyType: "info" });
            return out({ type: "prompt_result", id: rec.id, agentInvoked: false, status: "completed", sessionSettled: !running });
          }
          if (running) {
            if (!rec.streamingBehavior) return fail("Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.");
            queue[rec.streamingBehavior === "steer" ? "steering" : "followUp"].push(entry);
            running.ids.push(rec.id);
            queueUpdate();
            return ok();
          }
          ok();
          return run(entry);
        }
        case "abort":
          doAbort();
          return ok();
        case "abort_and_restore_queue": {
          const back = { steering: queue.steering.map((q) => ({ text: q.text })), followUp: queue.followUp.map((q) => ({ text: q.text })) };
          queue = { steering: [], followUp: [] };
          queueUpdate();
          doAbort();
          return ok(back);
        }
        case "remove_queued_message": {
          const lane = rec.queue === "steering" ? "steering" : "followUp";
          const i = queue[lane].findIndex((q) => q.text === rec.message);
          if (i >= 0) {
            queue[lane].splice(i, 1);
            queueUpdate();
          }
          return ok({ removed: i >= 0 });
        }
        case "extension_ui_response": {
          const r = asks.get(rec.id);
          asks.delete(rec.id);
          return r?.(rec);
        }
        case "set_model": {
          const m = MODELS.find((x) => x.provider === rec.provider && x.id === rec.modelId);
          if (!m) return fail(`Model not found: ${rec.provider}/${rec.modelId}`);
          model = m;
          append({ type: "model_change", model: `${m.provider}/${m.id}` });
          return ok(m);
        }
        case "set_thinking_level":
          thinking = rec.level;
          append({ type: "thinking_level_change", thinkingLevel: thinking });
          out({ type: "thinking_level_changed", level: thinking });
          return ok();
        case "set_session_name":
          if (!rec.name) return fail("Session name cannot be empty");
          s.title = rec.name;
          append({ type: "title_change", title: rec.name, source: "user" });
          return ok();
        case "compact": {
          if (messages().length < 2) {
            out({ type: "manual_compaction_start" });
            out({ type: "manual_compaction_end", aborted: false, skipped: true, errorMessage: "Nothing to compact (session too small)" });
            return fail("Nothing to compact (session too small)");
          }
          out({ type: "manual_compaction_start" });
          await sleep(sc.compactMs ?? 150);
          const result = { summary: "Summary.", firstKeptEntryId: s.leaf, tokensBefore: 48210, details: {} };
          out({ type: "manual_compaction_end", aborted: false, result });
          return ok(result);
        }
        case "new_session":
          if (running) doAbort();
          fresh(rec.parentSession);
          persist();
          return ok({ cancelled: false });
        case "switch_session":
          if (!existsSync(rec.sessionPath)) return fail(`Session not found: ${rec.sessionPath}`);
          if (running) doAbort();
          load(rec.sessionPath);
          return ok({ cancelled: false });
        case "fork": {
          if (running) return fail("Cannot fork while the session is busy", "session_busy");
          const path = branch();
          const at = rec.entryId ? path.findIndex((e) => e.id === rec.entryId) : path.length - 1;
          if (at < 0 || path[at].type !== "message") return fail(`Entry ${rec.entryId} is not a message`);
          const old = s.file;
          const keep = path.slice(0, at + 1);
          const id = randomUUID();
          s = { ...s, id, created: Date.now(), entries: keep, leaf: keep.at(-1).id, parent: old, file: noSession ? null : join(sessionDir(), `${new Date().toISOString().replace(/[:.]/g, "-")}_${id}.jsonl`) };
          persist();
          return ok({ cancelled: false });
        }
        default:
          return fail(`Unknown command: ${rec.type}`);
      }
    };
  }
}
