// omp (oh-my-pi) as a provider: `omp --mode rpc`. omp's RPC grew from Pi's and
// keeps most of its commands and events, so this reuses the Pi adapter's
// mapping where the wire matches. It differs where omp's protocol does
// (docs/dev/research/provider-omp.md): a `ready` frame and protocol v2
// (chunked frames), `prompt_result` per prompt and `session_settled` for the
// run's end, its own queue commands, tool approvals and ask dialogs over
// `extension_ui_request`, `get_available_commands`, OMP-native session entries.
import { execFile, execFileSync } from "node:child_process";
import { basename, dirname, join } from "node:path";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { OmpProcess } from "./rpc.ts";
import { PiRpcError } from "../pi/rpc.ts";
import type { PiRecord, Oversized } from "../pi/rpc.ts";
import { contentText, echoText, countImages, imageBlocks, resultText, resultImages } from "../pi/content.ts";
import { assistantEnd, historyEvents as piHistoryEvents, mapModel } from "../pi/adapter.ts";
import { agentEnv } from "../env.ts";
import { jsonlFiles } from "../../jsonl.ts";
import type {
  ProviderAdapter, AdapterHost, AdapterOptions, Capabilities, StartInfo, NormalizedEvent, AskAnswer, ImageBlock, ModelInfo,
  AgentCommand, AgentModel, SessionSource, UsageInfo, Prompt, Disposition, ForkPoint, PermissionChoice, Question,
} from "../types.ts";
import { OMP_TOOLS } from "./tools.ts";
import { SKILL_PROMPT, skillInvocation, skillTyped } from "./content.ts";
import { describeSession, sessionDirs, sessionId } from "./sessions.ts";

type Rec = Record<string, any>;

/** The oldest omp this adapter is written against (its RPC: prompt_result, session_settled, abort_and_restore_queue). */
const MIN_VERSION = [19, 1];

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}
function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/** A tool result's text as the card shows it: a read's text without omp's hashline header and line numbers. */
function toolOutput(name: string, result: unknown): string {
  const d = (result as Rec | null)?.details;
  if (name === "read" && typeof d?.displayContent?.text === "string") return d.displayContent.text;
  return resultText(result);
}

/** A user message the person sent via a skill (omp's `skill-prompt` custom message): its text and the skill. */
function skillMessage(m: Rec): { text: string; skills: { name: string; command: string; path?: string }[] } | null {
  if (m.customType !== SKILL_PROMPT) return null;
  const s = skillInvocation(m.details);
  return s ? { text: s.args, skills: [s.skill] } : null;
}

/** `get_messages` (or its pages) → the events that rebuild the timeline. */
export function historyEvents(messages: Rec[]): NormalizedEvent[] {
  const out: NormalizedEvent[] = [];
  for (const m of messages) {
    const ts = num(m.timestamp) ?? Date.now();
    if (m.role === "custom") {
      const skill = skillMessage(m);
      if (skill) {
        out.push({ type: "user_message", ...skill, images: 0, source: "composer", ts });
        continue;
      }
    } else if (m.role === "toolResult") {
      const result = { content: m.content, details: m.details };
      const name = str(m.toolName) ?? "tool";
      out.push({
        type: "tool_ended", callId: String(m.toolCallId), name, isError: m.isError === true,
        output: toolOutput(name, result), images: resultImages(result), result, ts,
      });
      continue;
    } else if (m.role === "user" && (m.attribution === "agent" || m.display === false)) {
      continue;
    }
    out.push(...piHistoryEvents([m]));
  }
  return out;
}

/** An approval select (omp docs/approval-mode.md: hosts without an approval dialog get a select): "Allow tool: <name>\n<details>". */
export function approvalOf(ev: Rec): { tool: string; details: string; choices: PermissionChoice[] } | null {
  if (ev.method !== "select" || typeof ev.title !== "string" || !Array.isArray(ev.options)) return null;
  const m = /^Allow tool: (\S+)\n?([\s\S]*)$/.exec(ev.title);
  const options: string[] = ev.options.map(String);
  if (!m || !options.some((o) => /^Deny\b/.test(o)) || !options.some((o) => /^Approve\b/.test(o))) return null;
  const choices = options.map((label): PermissionChoice => {
    if (/^Deny\b/.test(label)) return { id: label, label, kind: "deny" };
    if (/^Approve( Once)?$/.test(label)) return { id: label, label: label === "Approve" ? "Allow once" : label, kind: "allow" };
    if (/for this session$/.test(label)) return { id: label, label, kind: "allow_always" };
    return { id: label, label, kind: "other" };
  });
  return { tool: m[1]!, details: m[2]!.trim(), choices };
}

type Unechoed = { id: string; kind: "prompt" | "steer" | "followUp"; text: string; images: ImageBlock[] };
/** A prompt waiting for what it became: a run ("started"), or done without one ("handled"). */
type Outcome = { reqId: string | null; resolve: (d: Disposition) => void };
type PendingAsk = { kind: "permission" | "questions" | "dialog"; questions?: string[]; options?: Record<string, string[]> };

export class OmpAdapter implements ProviderAdapter {
  readonly id = "omp";
  readonly name = "omp";
  readonly tools = OMP_TOOLS;
  readonly capabilities: Capabilities = {
    steer: true, followUp: true, thinkingLevels: [], permissions: true, permissionModes: [],
    extensionUi: true, compact: true, compactInstructions: true, rename: true, fork: true, images: true, cost: true, tui: true,
  };
  private opts: AdapterOptions;
  private proc: OmpProcess | null = null;
  private host: AdapterHost | null = null;
  private activity = 0;
  private probeTimer: NodeJS.Timeout | null = null;
  /** The host's messages omp hasn't echoed yet, oldest first (omp has no client message ids). */
  private unechoed: Unechoed[] = [];
  /** omp's last queue_update. */
  private queue: { steering: string[]; followUp: string[] } = { steering: [], followUp: [] };
  private outcomes: Outcome[] = [];
  /** An abort was asked for since the run started: its settle is an aborted one. */
  private aborting = false;
  /** Tools running now (callId → name, args), for an approval's card. */
  private running = new Map<string, { name: string; args: unknown }>();
  private asks = new Map<string, PendingAsk>();
  /** omp's command list, from its `available_commands_update` frames. */
  private commandList: Rec[] | null = null;
  /** Protocol v2 is on: history can be paged. */
  private v2 = false;
  private logged = new Set<string>();

  constructor(opts: AdapterOptions) {
    this.opts = opts;
  }

  get alive(): boolean {
    return !!this.proc && !this.proc.exited;
  }

  private emit(ev: NormalizedEvent): void {
    this.host?.emit(ev);
  }

  private require(): OmpProcess {
    if (!this.proc) throw new Error("omp is not running. Use /reload to restart it.");
    return this.proc;
  }

  private logOnce(key: string, msg: string): void {
    if (this.logged.has(key)) return;
    this.logged.add(key);
    this.host?.log(msg);
  }

  // ---------------------------------------------------------------- lifecycle

  async start(session: string | null, host: AdapterHost): Promise<StartInfo> {
    this.host = host;
    this.unechoed = [];
    this.outcomes = [];
    this.queue = { steering: [], followUp: [] };
    this.running.clear();
    this.asks.clear();
    this.aborting = false;
    const args = ["--mode", "rpc", ...this.opts.args, ...(session ? ["--resume", session] : [])];
    host.log(`spawn ${this.opts.command} ${args.join(" ")}`);
    const omp = new OmpProcess({ command: this.opts.command, args, cwd: this.opts.cwd, env: agentEnv() });
    this.proc = omp;
    omp.onEvent = (rec) => this.proc === omp && this.onRecord(rec);
    omp.onOversized = (o) => this.proc === omp && this.onOversized(o);
    omp.onBadLine = (line) => host.log(`omp stdout (not JSON): ${line.slice(0, 200)}`);
    omp.onFrameError = (msg) => host.log(`omp frame dropped: ${msg}`);
    omp.onExit = (info) => {
      if (this.proc !== omp) return;
      this.proc = null;
      for (const o of this.outcomes.splice(0)) o.resolve("handled");
      host.emit({
        type: "exited", code: info.code, signal: info.signal, stderrTail: info.stderr,
        ...(info.spawnError ? { spawnError: info.spawnError } : {}), command: this.opts.command,
      });
    };
    this.probeVersion(host);
    // omp answers commands in order, after its `ready` frame and its extensions' startup.
    const negotiated = omp.request("negotiate_protocol", { protocolVersion: 2 }, 0).then(
      () => (this.v2 = true),
      (e) => host.log(`omp protocol v2 not available: ${e.message}`),
    );
    const quiet = (type: string, a: Rec) => omp.request(type, a, 0).catch((e) => host.log(`omp ${type}: ${e.message}`));
    void quiet("set_event_filter", { events: null, messageUpdates: "delta" });
    void quiet("set_ask_dialog", { enabled: true });
    const st = (await omp.request("get_state", {}, 0)) as Rec;
    await negotiated;
    this.applyState(st);
    await this.refreshLevels();
    return { streaming: st.isStreaming === true || st.isSettled === false, hasHistory: (st.messageCount ?? 0) > 0 };
  }

  watchRun(): void {
    this.probe(3000);
  }

  private probeVersion(host: AdapterHost): void {
    execFile(this.opts.command, ["--version"], { timeout: 10_000, env: agentEnv() }, (err, stdout) => {
      const v = err ? null : (/\d+\.\d+\.\d+[\w.-]*/.exec(stdout)?.[0] ?? null);
      host.emit({ type: "version", version: v });
      const [major = 0, minor = 0] = (v ?? "").split(".").map(Number);
      if (v && (major < MIN_VERSION[0]! || (major === MIN_VERSION[0] && minor < MIN_VERSION[1]!))) {
        host.emit({ type: "notice", level: "warning", source: "host", text: `omp ${v} is older than ${MIN_VERSION.join(".")}; the chat needs omp ${MIN_VERSION.join(".")} or newer.` });
      }
    });
  }

  private applyState(st: Rec): void {
    const model = mapModel(st.model);
    if (model) this.emitModel(model);
    const level = str(st.configuredThinkingLevel) === "auto" ? "auto" : str(st.thinkingLevel);
    if (level) this.emit({ type: "thinking", level });
    // By file only: the core gives `tuiCommand` the id when it has one, and `omp --resume <id>` searches only the
    // default session folders (a chat started with --session-dir would lose it); a path opens the file itself.
    this.emit({ type: "session", file: str(st.sessionFile) ?? null, name: str(st.sessionName) || null });
  }

  private emitModel(model: ModelInfo): void {
    this.emit({ type: "model", model });
    this.emit({ type: "capabilities", capabilities: { images: model.input.includes("image") } });
  }

  /** The current model's thinking levels (omp's `get_available_thinking_levels`, plus its per-turn `auto` when it has efforts). */
  private async refreshLevels(): Promise<void> {
    if (!this.proc) return;
    try {
      const d = (await this.proc.request("get_available_thinking_levels", {}, 15_000)) as Rec;
      const levels: string[] = Array.isArray(d?.levels) ? d.levels.map(String) : [];
      this.emit({ type: "capabilities", capabilities: { thinkingLevels: levels.length > 1 ? [...levels, "auto"] : levels } });
    } catch (e) {
      this.host?.log(`omp get_available_thinking_levels: ${e instanceof Error ? e.message : e}`);
    }
  }

  private async refreshState(): Promise<void> {
    if (!this.proc) return;
    try {
      this.applyState((await this.proc.request("get_state", {}, 10_000)) as Rec);
      await this.refreshLevels();
    } catch {}
  }

  async dispose(): Promise<void> {
    const omp = this.proc;
    if (!omp) return;
    this.proc = null;
    clearTimeout(this.probeTimer ?? undefined);
    this.probeTimer = null;
    for (const o of this.outcomes.splice(0)) o.resolve("handled");
    await omp.stop();
  }

  kill(): void {
    this.proc?.killNow();
  }

  // ---------------------------------------------------------------- events

  private onRecord(rec: PiRecord): void {
    const ev = rec as Rec;
    const t = ev.type;
    if (t !== "extension_ui_request" && t !== "response" && t !== "ready" && t !== "available_commands_update") {
      this.activity++;
      this.emit({ type: "heartbeat" });
    }
    switch (t) {
      case "ready":
      case "response":
        if (t === "response" && ev.command === "parse" && ev.success === false) this.host?.log(`omp parse error: ${ev.error}`);
        return;
      case "agent_start":
        this.emit({ type: "run_started" });
        for (const o of this.outcomes.splice(0)) o.resolve("started");
        return;
      case "agent_end":
        // Only `session_settled` ends the run (background work can wake it); the probe covers one that never comes.
        if (ev.isTerminal !== false) this.probe(5000);
        return;
      case "prompt_result":
        this.onPromptResult(ev);
        return;
      case "session_settled":
        this.settle();
        return;
      case "turn_end":
        this.emit({ type: "turn_end" });
        return;
      case "message_start":
        this.onMessageStart(ev.message ?? {});
        return;
      case "message_update":
        this.onMessageUpdate(ev.assistantMessageEvent ?? {});
        return;
      case "message_end":
        if (ev.message?.role === "assistant") this.emit(assistantEnd(ev.message));
        return;
      case "tool_execution_start": {
        const callId = String(ev.toolCallId);
        const name = str(ev.toolName) ?? "tool";
        this.running.set(callId, { name, args: ev.args });
        this.emit({ type: "tool_started", callId, name, args: ev.args });
        return;
      }
      case "tool_execution_update": {
        const name = str(ev.toolName) ?? "tool";
        this.emit({
          type: "tool_progress", callId: String(ev.toolCallId), name, args: ev.args,
          ...(ev.partialResult !== undefined ? { output: toolOutput(name, ev.partialResult) } : {}),
        });
        return;
      }
      case "tool_execution_end": {
        const callId = String(ev.toolCallId);
        const name = str(ev.toolName) ?? "tool";
        this.running.delete(callId);
        const durationMs = num(ev.durationMs);
        this.emit({
          type: "tool_ended", callId, name, args: ev.args, isError: ev.isError === true,
          output: toolOutput(name, ev.result), images: resultImages(ev.result), result: ev.result, ...(durationMs !== undefined ? { durationMs } : {}),
        });
        return;
      }
      case "queue_update":
        this.onQueue((ev.steering ?? []).map(String), (ev.followUp ?? []).map(String));
        return;
      case "manual_compaction_start":
        this.emit({ type: "compaction", phase: "start", reason: "manual" });
        return;
      case "auto_compaction_start":
        this.emit({ type: "compaction", phase: "start", reason: ev.reason === "overflow" ? "overflow" : "auto" });
        return;
      case "manual_compaction_end":
      case "auto_compaction_end": {
        const r: Rec | null = ev.result && typeof ev.result === "object" ? ev.result : null;
        const error = str(ev.errorMessage);
        this.emit({
          type: "compaction", phase: "end", outcome: r ? "done" : ev.aborted ? "aborted" : "failed",
          ...(r ? { tokensBefore: num(r.tokensBefore) ?? 0, tokensAfter: num(r.tokensAfter) ?? num(r.estimatedTokensAfter) ?? 0 } : {}),
          ...(!r && error ? { error } : {}),
        });
        return;
      }
      case "auto_retry_start":
        this.emit({ type: "retry", phase: "start", attempt: ev.attempt ?? 1, maxAttempts: ev.maxAttempts ?? null, delayMs: ev.delayMs ?? 0, error: String(ev.errorMessage ?? "error") });
        return;
      case "auto_retry_end":
        this.emit({ type: "retry", phase: "end", success: !!ev.success, attempt: ev.attempt ?? null, ...(ev.finalError !== undefined && ev.finalError !== null ? { error: String(ev.finalError) } : {}) });
        return;
      case "retry_fallback_applied":
        this.emit({ type: "notice", level: "warning", source: "retry", text: `Switched to ${ev.to ?? "the next model"}${ev.reason ? ` after: ${ev.reason}` : ""}` });
        void this.refreshState();
        return;
      case "retry_fallback_succeeded":
        this.emit({ type: "notice", level: "info", source: "retry", text: `${ev.model ?? "The fallback model"} answered.` });
        return;
      case "thinking_level_changed":
        if (typeof ev.level === "string") this.emit({ type: "thinking", level: ev.level });
        return;
      case "model_changed":
        void this.refreshState();
        return;
      case "session_info_update": {
        const name = str(ev.name) ?? str(ev.title) ?? str(ev.sessionName);
        if (name !== undefined) this.emit({ type: "session", name: name || null });
        else void this.refreshState();
        return;
      }
      case "extension_error": {
        const ext = typeof ev.extensionPath === "string" ? basename(ev.extensionPath) : "an extension";
        this.emit({ type: "notice", level: "error", source: "extension_error", text: `Extension error in ${ext}${ev.event ? ` (${ev.event})` : ""}: ${ev.error ?? ""}` });
        return;
      }
      case "extension_ui_request":
        this.onUi(ev);
        return;
      case "available_commands_update":
        if (Array.isArray(ev.commands)) this.commandList = ev.commands;
        return;
      case "notice": {
        const level = ev.level === "error" ? "error" : ev.level === "warning" ? "warning" : "info";
        const text = str(ev.message) ?? str(ev.text);
        if (text) this.emit({ type: "notice", level, source: "notify", text });
        return;
      }
      case "command_output":
        if (typeof ev.text === "string" && ev.text) this.emit({ type: "notice", level: "info", source: "notify", text: ev.text });
        return;
      case "ttsr_triggered": {
        const names = Array.isArray(ev.rules) ? ev.rules.map((r: Rec) => str(r?.name)).filter(Boolean) : [];
        if (names.length) this.emit({ type: "notice", level: "info", source: "notify", text: `Rule injected: ${names.join(", ")}` });
        return;
      }
      case "goal_updated": {
        const objective = str(ev.goal?.objective);
        this.emit({ type: "notice", level: "info", source: "notify", text: objective ? `Goal: ${objective}` : "Goal cleared." });
        return;
      }
      case "rpc_frame_error":
        this.emit({ type: "notice", level: "warning", source: "host", text: `omp sent an update too large to show${ev.error ? ` (${ev.error})` : ""}, so part of this turn is missing here.`, once: "run" });
        return;
      default:
        this.logOnce(`event:${t}`, `omp event ${t} ignored`);
    }
  }

  private onMessageStart(m: Rec): void {
    if (m.role === "user") {
      if (m.attribution === "agent" || m.display === false) return;
      const clientId = this.takeEchoed(m.steering === true);
      this.emit({ type: "user_message", text: echoText(m.content), images: countImages(m.content), imageBlocks: imageBlocks(m.content), ...(clientId ? { clientId } : {}) });
    } else if (m.role === "custom" && m.display !== false) {
      const skill = skillMessage(m);
      if (skill && m.attribution !== "agent") {
        const clientId = this.takeEchoed(false);
        this.emit({ type: "user_message", ...skill, images: 0, ...(clientId ? { clientId } : {}) });
        return;
      }
      this.emit({ type: "custom", customType: String(m.customType ?? "custom"), text: contentText(m.content) });
      this.emit({ type: "run_cause", text: `Started by ${m.customType ?? "an extension"}.` });
    } else if (m.role === "assistant") {
      this.emit({ type: "assistant_start" });
    }
  }

  private onMessageUpdate(u: Rec): void {
    const index = num(u.contentIndex) ?? 0;
    switch (u.type) {
      case "text_start":
      case "thinking_start":
        this.emit({ type: "assistant_block_start", index, kind: u.type === "text_start" ? "text" : "thinking" });
        return;
      case "text_delta":
      case "thinking_delta":
        if (typeof u.delta === "string") this.emit({ type: "assistant_delta", index, kind: u.type === "text_delta" ? "text" : "thinking", delta: u.delta });
        return;
      case "text_end":
      case "thinking_end":
        this.emit({ type: "assistant_block_end", index, kind: u.type === "text_end" ? "text" : "thinking", ...(typeof u.content === "string" ? { text: u.content } : {}) });
        return;
      case "toolcall_start": {
        const b: Rec = u.block ?? {};
        this.emit({ type: "tool_call_start", index, callId: str(b.id) ?? str(u.id) ?? `call-${index}`, name: str(b.name) ?? str(u.toolName) ?? "tool" });
        return;
      }
      case "toolcall_delta":
        this.emit({ type: "tool_call_delta", index, delta: str(u.delta) ?? "" });
        return;
      case "toolcall_end": {
        const call: Rec = u.toolCall ?? {};
        this.emit({ type: "tool_call", index, callId: str(call.id) ?? `call-${index}`, name: str(call.name) ?? "tool", args: call.arguments });
        return;
      }
    }
  }

  private onPromptResult(ev: Rec): void {
    const i = this.outcomes.findIndex((o) => o.reqId === ev.id);
    if (i >= 0) {
      const [o] = this.outcomes.splice(i, 1);
      o!.resolve(ev.agentInvoked === false ? "handled" : "started");
    }
    if (ev.status === "aborted") this.aborting = true;
    const err: Rec | null = ev.status === "error" && ev.error && typeof ev.error === "object" ? ev.error : null;
    // A failed provider turn ends with an error message of its own; these failed before reaching one.
    if (err && (ev.agentInvoked === false || err.code === "cost_cap")) this.emit({ type: "notice", level: "error", source: "host", text: String(err.message ?? "The prompt failed") });
    // A prompt that never reached the agent has no `session_settled`: settle by state.
    if (ev.sessionSettled === true) this.probe(1500);
  }

  private settle(): void {
    clearTimeout(this.probeTimer ?? undefined);
    this.probeTimer = null;
    // A prompt's echo comes inside its run.
    this.unechoed = this.unechoed.filter((u) => u.kind !== "prompt");
    this.running.clear();
    const aborted = this.aborting;
    this.aborting = false;
    this.emit({ type: "run_settled", aborted });
  }

  private onQueue(steering: string[], followUp: string[]): void {
    this.queue = { steering, followUp };
    // Each text that is one of ours, in order: the oldest of ours with that text.
    const ids = (kind: "steer" | "followUp", texts: string[]) => {
      const mine = this.unechoed.filter((u) => u.kind === kind);
      return texts.map((t) => {
        const i = mine.findIndex((u) => u.text === t);
        return i >= 0 ? mine.splice(i, 1)[0]!.id : null;
      });
    };
    this.emit({ type: "queue_changed", steering, followUp, steeringIds: ids("steer", steering), followUpIds: ids("followUp", followUp) });
  }

  private onUi(ev: Rec): void {
    const id = String(ev.id ?? "");
    const timeoutAt = typeof ev.timeout === "number" && ev.timeout > 0 ? { timeoutAt: Date.now() + ev.timeout } : {};
    switch (ev.method) {
      case "select": {
        const approval = approvalOf(ev);
        if (approval) {
          const call = [...this.running].reverse().find(([, r]) => r.name === approval.tool);
          this.asks.set(id, { kind: "permission" });
          this.emit({
            type: "ask",
            ask: {
              id, kind: "permission", title: `Allow ${approval.tool}?`, ...(approval.details ? { message: approval.details } : {}),
              tool: { name: approval.tool, ...(call ? { args: call[1].args, callId: call[0] } : {}) }, choices: approval.choices, ...timeoutAt,
            },
          });
          return;
        }
      }
      // falls through: a plain select
      case "confirm":
      case "input":
      case "editor":
        this.asks.set(id, { kind: "dialog" });
        this.emit({
          type: "ask",
          ask: {
            id, kind: ev.method, title: String(ev.title ?? ""),
            ...(typeof ev.message === "string" ? { message: ev.message } : {}),
            ...(Array.isArray(ev.options) ? { options: ev.options.map((o: unknown) => String(o)) } : {}),
            ...(typeof ev.placeholder === "string" ? { placeholder: ev.placeholder } : {}),
            ...(typeof ev.prefill === "string" ? { prefill: ev.prefill } : {}),
            ...timeoutAt,
          },
        });
        return;
      case "ask": {
        const qs: Rec[] = Array.isArray(ev.questions) ? ev.questions : [];
        const questions: Question[] = qs.map((q, qi) => ({
          id: String(q.id ?? qi), question: String(q.question ?? ""), ...(typeof q.header === "string" ? { header: q.header } : {}),
          options: (Array.isArray(q.options) ? q.options : []).map((o: Rec, oi: number) => ({
            label: String(o?.label ?? ""), ...(typeof o?.description === "string" ? { description: o.description } : {}), ...(q.recommended === oi ? { recommended: true } : {}),
          })),
          multiSelect: q.multi === true, allowOther: true,
        }));
        this.asks.set(id, { kind: "questions", questions: questions.map((q) => q.id), options: Object.fromEntries(questions.map((q) => [q.id, q.options.map((o) => o.label)])) });
        this.emit({ type: "ask", ask: { id, kind: "questions", title: questions.length === 1 ? questions[0]!.question : "omp has questions", questions, ...timeoutAt } });
        return;
      }
      case "form":
        // No form renderer here: omp expects every form answered, so cancel it at once and say where it can be answered.
        this.proc?.write({ type: "extension_ui_response", id, cancelled: true });
        this.emit({ type: "notice", level: "warning", source: "notify", text: "omp asked for a form, which the chat can't show yet; it was cancelled. Use /tui to answer it in omp." });
        return;
      case "cancel":
        if (typeof ev.targetId === "string") {
          this.asks.delete(ev.targetId);
          this.emit({ type: "ask_closed", id: ev.targetId });
        }
        return;
      case "notify": {
        const level = ev.notifyType === "error" ? "error" : ev.notifyType === "warning" ? "warning" : "info";
        this.emit({ type: "notice", level, source: "notify", text: String(ev.message ?? "") });
        return;
      }
      case "setStatus":
        this.emit({ type: "status", key: String(ev.statusKey ?? ""), text: typeof ev.statusText === "string" && ev.statusText.length ? ev.statusText : null });
        return;
      case "setWidget":
        this.emit({
          type: "widget", key: String(ev.widgetKey ?? ""), placement: ev.widgetPlacement === "belowEditor" ? "belowEditor" : "aboveEditor",
          lines: Array.isArray(ev.widgetLines) ? ev.widgetLines.slice(0, 200).map(String) : null,
        });
        return;
      case "setTitle":
        this.emit({ type: "title", text: typeof ev.title === "string" && ev.title ? ev.title : null });
        return;
      case "set_editor_text":
        this.emit({ type: "editor_text", text: typeof ev.text === "string" ? ev.text : null });
        return;
      case "open_url":
        this.emit({ type: "notice", level: "info", source: "notify", text: `Open ${ev.launchUrl ?? ev.url}${ev.instructions ? `\n${ev.instructions}` : ""}` });
        return;
      default:
        // A method this host doesn't know may await an answer: cancel it so omp doesn't hang.
        if (id) this.proc?.write({ type: "extension_ui_response", id, cancelled: true });
    }
  }

  /**
   * Settle fallback: when omp shows no activity for `delay` ms while the core
   * thinks a run is on, ask get_state and settle when it is settled.
   */
  private probe(delay: number): void {
    clearTimeout(this.probeTimer ?? undefined);
    const rev = this.activity;
    this.probeTimer = setTimeout(async () => {
      this.probeTimer = null;
      const omp = this.proc;
      const host = this.host;
      if (!omp || !host || rev !== this.activity) return;
      if (!host.running && !host.working) return;
      let st: Rec;
      try {
        st = (await omp.request("get_state", {}, 10_000)) as Rec;
      } catch {
        return;
      }
      if (rev !== this.activity) return;
      const settled = st.isSettled === true || (st.isSettled === undefined && !st.isStreaming && !st.isCompacting && !(st.queuedMessageCount > 0));
      if (settled) {
        host.log("settled by get_state probe");
        this.settle();
      } else {
        this.probe(Math.max(delay, 2000));
      }
    }, delay);
  }

  /** A record over the record cap: recover what it was from its head, so the timeline stays consistent. */
  private onOversized(o: Oversized): void {
    this.activity++;
    this.emit({ type: "heartbeat" });
    const type = /^\{"type":"([a-z_]+)"/.exec(o.head)?.[1] ?? null;
    const mb = (o.size / 1048576).toFixed(1);
    this.host?.log(`dropped an oversized omp record (${type ?? "unknown"}, ${o.size} bytes)`);
    const tool = /^\{"type":"tool_execution_(start|update|end)","toolCallId":"([^"\\]+)","toolName":"([^"\\]+)"/.exec(o.head);
    if (tool) {
      const [, phase, callId, name] = tool as unknown as [string, string, string, string];
      this.emit({ type: "tool_started", callId, name });
      if (phase === "end") {
        this.running.delete(callId);
        this.emit({ type: "tool_ended", callId, name, isError: false, output: "", lostBytes: o.size });
      }
    } else if (type === "message_end" && /^\{"type":"message_end","message":\{"role":"assistant"/.test(o.head)) {
      this.emit({ type: "assistant_end", content: [] });
    }
    this.emit({ type: "notice", level: "warning", source: "host", text: `omp sent an update too large to show (${mb} MiB), so part of this turn is missing here.`, once: "run" });
    if (this.host?.running) this.probe(3000);
  }

  // ---------------------------------------------------------------- commands

  async prompt(p: Prompt): Promise<{ disposition: Disposition }> {
    const omp = this.require();
    const behavior: "steer" | "followUp" | undefined = p.busy ? (p.mode === "followUp" ? "followUp" : "steer") : undefined;
    const images = p.images.map((i) => ({ type: "image", data: i.data, mimeType: i.mimeType }));
    // Recorded before anything awaits: the echo can come before the reply.
    const entry: Unechoed = { id: p.id, kind: behavior ?? "prompt", text: p.text, images: p.images };
    this.unechoed.push(entry);
    const forget = () => {
      const i = this.unechoed.indexOf(entry);
      if (i >= 0) this.unechoed.splice(i, 1);
    };
    // An idle prompt becomes a run (its agent_start) or ends without one (its prompt_result); the reply alone doesn't say.
    let outcome: Outcome | undefined;
    let became: Promise<Disposition> | undefined;
    if (!behavior) {
      let resolve: (d: Disposition) => void = () => {};
      became = new Promise<Disposition>((r) => (resolve = r));
      outcome = { reqId: null, resolve };
      this.outcomes.push(outcome);
    }
    const reply = omp.request("prompt", { message: p.text, ...(images.length ? { images } : {}), ...(behavior ? { streamingBehavior: behavior } : {}) }, 0);
    if (outcome) outcome.reqId = omp.lastId;
    let d: Rec;
    try {
      d = (await reply) as Rec;
    } catch (e) {
      forget();
      if (outcome) this.outcomes = this.outcomes.filter((o) => o !== outcome);
      throw e;
    }
    let disposition: Disposition = behavior ? "queued" : "started";
    if (d?.agentInvoked === false) {
      disposition = "handled";
      if (outcome) this.outcomes = this.outcomes.filter((o) => o !== outcome);
    } else if (became) {
      disposition = await became;
    }
    if (disposition === "handled") forget();
    return { disposition };
  }

  /** The host's message a user echo is: a steer when omp marks it so, else the prompt, else a follow-up. */
  private takeEchoed(steering: boolean): string | undefined {
    const next = steering
      ? this.unechoed.find((u) => u.kind === "steer")
      : (this.unechoed.find((u) => u.kind === "prompt") ?? this.unechoed.find((u) => u.kind === "followUp") ?? this.unechoed.find((u) => u.kind === "steer"));
    if (!next) return undefined;
    this.unechoed.splice(this.unechoed.indexOf(next), 1);
    return next.id;
  }

  /** omp's Esc: take the queued messages back and abort, in one step (`abort_and_restore_queue`). */
  async clearQueue(): Promise<string[]> {
    const omp = this.proc;
    if (!omp) return [];
    const queued = this.queue.steering.length + this.queue.followUp.length > 0;
    if (!queued && !this.host?.running) return [];
    try {
      this.aborting = true;
      const q = (await omp.request("abort_and_restore_queue", {}, 15_000)) as Rec;
      this.unechoed = this.unechoed.filter((u) => u.kind === "prompt");
      return [...(q?.steering ?? []), ...(q?.followUp ?? [])].map((e: Rec | string) => (typeof e === "string" ? e : String(e?.text ?? "")));
    } catch {
      return [];
    }
  }

  canRemoveQueued(id: string): boolean {
    const u = this.unechoed.find((x) => x.id === id);
    if (!u || u.kind === "prompt") return false;
    return (u.kind === "steer" ? this.queue.steering : this.queue.followUp).includes(u.text);
  }

  async removeQueued(id: string): Promise<boolean> {
    const u = this.unechoed.find((x) => x.id === id);
    if (!u || u.kind === "prompt") return false;
    const d = (await this.require().request("remove_queued_message", { message: u.text, queue: u.kind === "steer" ? "steering" : "followUp" }, 10_000)) as Rec;
    if (d?.removed !== true) return false;
    this.unechoed = this.unechoed.filter((x) => x !== u);
    return true;
  }

  abort(): void {
    const omp = this.proc;
    if (!omp) return;
    this.aborting = true;
    omp.request("abort", {}, 0)
      .then(() => this.probe(300))
      .catch(() => {});
    this.probe(5000);
  }

  answer(askId: string, a: AskAnswer): void {
    const ask = this.asks.get(askId);
    this.asks.delete(askId);
    const write = (r: Rec) => this.proc?.write({ type: "extension_ui_response", id: askId, ...r });
    if ("cancelled" in a) return void write({ cancelled: true });
    if (ask?.kind === "permission" && "choice" in a) {
      write({ value: a.choice });
      // omp's own UI denies and steers with what was typed: the same here.
      if (a.message && /^Deny\b/.test(a.choice) && this.proc) {
        this.proc.request("prompt", { message: a.message, streamingBehavior: "steer" }, 0).catch((e) => this.host?.log(`omp steer after deny: ${e.message}`));
      }
      return;
    }
    if (ask?.kind === "questions" && "answers" in a) {
      const answers = (ask.questions ?? []).map((qid) => {
        const v = a.answers[qid];
        const picked = (Array.isArray(v) ? v : typeof v === "string" && v ? [v] : []).map(String);
        const labels = ask.options?.[qid] ?? [];
        const selectedOptions = picked.filter((x) => labels.includes(x));
        const other = picked.filter((x) => !labels.includes(x)).join(", ").trim();
        return { id: qid, selectedOptions, ...(other ? { customInput: other } : {}) };
      });
      return void write({ answers });
    }
    if ("confirmed" in a || "value" in a) return void write(a);
    if ("choice" in a) return void write({ value: a.choice });
    write({ cancelled: true });
  }

  /** The session's messages, a page at a time under protocol v2 (whole when paging isn't possible). */
  async history(): Promise<NormalizedEvent[]> {
    const omp = this.require();
    if (this.v2) {
      try {
        const messages: Rec[] = [];
        const seen = new Set<string>();
        let cursor: string | undefined;
        for (;;) {
          const d = (await omp.request("get_messages_page", { limit: 100, ...(cursor ? { cursor } : {}) }, 30_000)) as Rec;
          if (Array.isArray(d?.messages)) messages.push(...d.messages);
          const next = str(d?.nextCursor);
          const total = num(d?.totalMessages);
          if (next && seen.has(next)) throw new PiRpcError("get_messages_page", "omp gave the same history page twice", false, "stale_cursor");
          if (!next || (total !== undefined && messages.length >= total)) break;
          seen.add(next);
          cursor = next;
        }
        return historyEvents(messages);
      } catch (e) {
        if (!(e instanceof PiRpcError && (e.code === "session_busy" || e.code === "stale_cursor"))) throw e;
        this.host?.log(`omp get_messages_page: ${e.message}; reading the whole history`);
      }
    }
    const data = (await omp.request("get_messages", {}, 30_000)) as Rec;
    return historyEvents(Array.isArray(data?.messages) ? data.messages : []);
  }

  readonly sessions: SessionSource = {
    kind: "files",
    files: (current, scope) => jsonlFiles([...sessionDirs(this.opts.cwd, this.opts.args, scope), ...(current ? [dirname(current)] : [])]),
    describe: describeSession,
  };

  /** omp's models; the ones its picker lists first (recent, or holding a role) come first. */
  async listModels(): Promise<AgentModel[]> {
    const omp = this.require();
    const [d, picker] = await Promise.all([
      omp.request("get_available_models", {}, 60_000) as Promise<Rec>,
      (omp.request("get_model_picker", { limit: 50 }, 15_000) as Promise<Rec>).catch(() => null),
    ]);
    const rows: Rec[] = Array.isArray(picker?.rows) ? picker!.rows : [];
    const recent = num(picker?.recent) ?? 0;
    const preferred = new Set(rows.filter((r, i) => i < recent || (Array.isArray(r.roles) && r.roles.length > 0) || r.current === true).map((r) => `${r.provider}/${r.id}`));
    const list: Rec[] = Array.isArray(d?.models) ? d.models : [];
    return list.map((m) => ({
      provider: String(m.provider), id: String(m.id), name: String(m.name ?? m.id), reasoning: m.reasoning === true,
      enabled: preferred.has(`${m.provider}/${m.id}`),
    }));
  }

  /** omp's commands: builtins, extensions' and custom ones, file commands (prompt templates) and skills. */
  async commands(): Promise<AgentCommand[]> {
    let list = this.commandList;
    try {
      const d = (await this.require().request("get_available_commands", {}, 15_000)) as Rec;
      if (Array.isArray(d?.commands)) list = this.commandList = d.commands;
    } catch (e) {
      if (!list) throw e;
    }
    return (list ?? [])
      .filter((c: Rec) => c && typeof c === "object" && typeof c.name === "string")
      .map((c: Rec) => ({
        name: c.name, description: [str(c.description), str(c.input?.hint)].filter(Boolean).join(" "),
        source: c.source === "skill" ? "skill" : c.source === "file" || c.source === "prompt" ? "prompt" : "extension",
      }));
  }

  async usage(): Promise<UsageInfo> {
    const s = (await this.require().request("get_session_stats", {}, 15_000)) as Rec;
    const cu: Rec = s?.contextUsage ?? {};
    return {
      contextTokens: typeof cu.tokens === "number" ? cu.tokens : null,
      contextWindow: typeof cu.contextWindow === "number" ? cu.contextWindow : null,
      percent: typeof cu.percent === "number" ? cu.percent : null,
      cost: typeof s?.cost === "number" ? s.cost : null,
    };
  }

  tuiCommand(session: string): string[] {
    return [this.opts.command, "--resume", session];
  }

  /**
   * omp's own guard: a live omp holds an OS lease per session id (`omp session
   * lease`). The holder's pid is the process with its lease file open.
   */
  sessionHolder(session: string): { pid: number } | null {
    const id = sessionId(session);
    if (!id) return null;
    let held: string[];
    try {
      const out = execFileSync(this.opts.command, ["session", "lease", "--json", "--", id], { encoding: "utf8", timeout: 5000, env: agentEnv() });
      held = JSON.parse(out).held ?? [];
    } catch {
      return null;
    }
    if (!held.includes(id)) return null;
    const own = this.proc?.pid;
    const dirs = [join(homedir(), process.env.PI_CONFIG_DIR || ".omp", "run", "session-owners"), ...(process.env.XDG_STATE_HOME ? [join(process.env.XDG_STATE_HOME, "omp", "run", "session-owners")] : [])];
    for (const dir of dirs) {
      const file = join(dir, `${id}.lock`);
      if (!existsSync(file)) continue;
      try {
        const pids = execFileSync("lsof", ["-t", file], { encoding: "utf8", timeout: 5000 }).split("\n").map(Number).filter((n) => n > 0 && n !== own);
        if (pids.length) return { pid: pids[0]! };
        if (own) return null; // only this adapter's own omp has it
      } catch {}
    }
    return { pid: 0 };
  }

  /** /login and /settings run in omp's TUI with no session. */
  utilityCommand(name: string): string[] | null {
    return ["login", "settings"].includes(name) ? [this.opts.command, "--no-session"] : null;
  }

  tuiInput(name: string): string | null {
    return ["login", "settings"].includes(name) ? `/${name}` : null;
  }

  readonly unsentMessageCause = "Started by an extension message.";

  async setModel(provider: string, id: string): Promise<void> {
    const m = (await this.require().request("set_model", { provider, modelId: id }, 60_000)) as Rec;
    const model = mapModel(m);
    if (model) this.emitModel(model);
    await this.refreshState();
  }

  async setThinking(level: string): Promise<void> {
    await this.require().request("set_thinking_level", { level }, 15_000);
    this.emit({ type: "thinking", level });
  }

  async setPermissionMode(): Promise<void> {
    throw new Error("omp's approval mode is set when it starts (--approval-mode), not over RPC");
  }

  async compact(instructions?: string): Promise<void> {
    await this.require().request("compact", instructions ? { customInstructions: instructions } : {}, 0);
  }

  private async afterSessionChange(): Promise<void> {
    this.unechoed = [];
    this.running.clear();
    await this.refreshState();
  }

  async newSession(): Promise<void> {
    const d = (await this.require().request("new_session", {}, 30_000)) as Rec;
    if (d?.cancelled) throw new Error("An extension cancelled the new session");
    await this.afterSessionChange();
  }

  async switchSession(path: string): Promise<void> {
    let d: Rec;
    try {
      d = (await this.require().request("switch_session", { sessionPath: path }, 60_000)) as Rec;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/Could not restore model/i.test(msg)) throw new Error(`omp can't open this session: ${msg}. Sign in to that model's provider, or pick another model and resume again.`);
      throw e;
    }
    if (d?.cancelled) throw new Error("An extension cancelled the switch");
    await this.afterSessionChange();
  }

  async setName(name: string): Promise<void> {
    await this.require().request("set_session_name", { name }, 15_000);
    this.emit({ type: "session", name: name || null });
  }

  /** The active branch's entries, root first (`get_entries` holds every branch). */
  private async branch(): Promise<Rec[]> {
    const d = (await this.require().request("get_entries", {}, 30_000)) as Rec;
    const entries: Rec[] = Array.isArray(d?.entries) ? d.entries : [];
    const byId = new Map(entries.map((e) => [e.id, e]));
    const path: Rec[] = [];
    for (let e = byId.get(d?.leafId); e && path.length <= entries.length; e = byId.get(e.parentId)) path.push(e);
    return path.reverse();
  }

  async forkPoints(): Promise<ForkPoint[]> {
    const out: ForkPoint[] = [];
    for (const e of await this.branch()) {
      if (e.type === "message" && e.message?.role === "user" && e.message.attribution !== "agent") out.push({ id: e.id, text: contentText(e.message.content) });
      else if (e.type === "custom_message" && e.customType === SKILL_PROMPT) out.push({ id: e.id, text: skillTyped(e.details) ?? "" });
    }
    return out;
  }

  /**
   * omp's fork keeps the entry it is given: fork at the last message before
   * this one (a new, empty session when there is none).
   */
  async fork(point: string): Promise<{ text: string }> {
    const omp = this.require();
    const branch = await this.branch();
    const at = branch.findIndex((e) => e.id === point);
    if (at < 0) throw new Error("That message is no longer in this session");
    const target = branch[at]!;
    const text = target.type === "custom_message" ? (skillTyped(target.details) ?? "") : contentText(target.message?.content);
    const before = branch.slice(0, at).reverse().find((e) => e.type === "message");
    let d: Rec;
    try {
      const file = (await omp.request("get_state", {}, 10_000) as Rec)?.sessionFile;
      d = before
        ? ((await omp.request("fork", { entryId: before.id }, 60_000)) as Rec)
        : ((await omp.request("new_session", typeof file === "string" ? { parentSession: file } : {}, 30_000)) as Rec);
    } catch (e) {
      if (e instanceof PiRpcError && e.code === "session_busy") throw new Error("omp is busy: fork once the run ends");
      throw e;
    }
    if (d?.cancelled) throw new Error("An extension cancelled the fork");
    await this.afterSessionChange();
    return { text };
  }
}
