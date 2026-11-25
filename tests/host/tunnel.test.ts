// A chat whose host runs on another machine (host/tunnel.ts): the mod's WebSocket goes to the
// tunnel on 127.0.0.1, which runs the machine's transport per connection with `pipe` at the far
// end. Here the "transport" runs the pipe on this computer: the bytes take the same path.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import WebSocket from "ws";
import { HOST_ENTRY, HOST_NODE, idle, sleep, startHost } from "./harness.ts";

type Rec = Record<string, any>;

async function until<T>(f: () => T | null | undefined | false, ms: number, what: string): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = f();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timed out: ${what}`);
    await sleep(20);
  }
}

function startTunnel(remotePort: number, stateFile: string, idleMs: number): { proc: ChildProcess; stderr: () => string; exited: Promise<number | null> } {
  const proc = spawn(HOST_NODE, [HOST_ENTRY, "tunnel", "--port", String(remotePort), "--state-file", stateFile, "--idle", String(idleMs),
    "--", HOST_NODE, HOST_ENTRY, "pipe", "--port", String(remotePort)], { stdio: ["ignore", "ignore", "pipe"] });
  let err = "";
  proc.stderr!.on("data", (d) => (err += d));
  const exited = new Promise<number | null>((r) => proc.on("exit", (code) => r(code)));
  return { proc, stderr: () => err, exited };
}

const readState = (f: string) => (existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : null);

/** A free port nothing listens on (bound, then released). */
async function deadPort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
  const addr = s.address();
  const port = addr && typeof addr === "object" ? addr.port : 0;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

test("a chat through the tunnel: hello, snapshot and a turn reach the mod's WebSocket, and the tunnel ends once nothing is connected", async () => {
  const h = await startHost({ name: "tunnel-chat", scenario: "tools.json", speed: 5 });
  let ws: WebSocket | null = null;
  const stateFile = join(h.dir, "tunnels", "m1-chat.json");
  const t = startTunnel(h.registry!.wsPort!, stateFile, 500);
  try {
    await h.client.waitFor(idle, 10_000, "idle at start");
    const state = await until(() => readState(stateFile), 10_000, `the tunnel's state file (${t.stderr()})`);
    assert.equal(state.pid, t.proc.pid);
    assert.equal(state.remotePort, h.registry!.wsPort);
    assert.ok(state.port > 0 && state.port !== h.registry!.wsPort, `the tunnel listens on a port of its own: ${state.port}`);

    const recs: Rec[] = [];
    ws = new WebSocket(`ws://127.0.0.1:${state.port}/`);
    ws.on("message", (data) => {
      ws!.send(JSON.stringify({ t: "ack" }));
      for (const line of String(data).split("\n")) recs.push(JSON.parse(line));
    });
    await new Promise<void>((resolve, reject) => { ws!.once("open", () => resolve()); ws!.once("error", reject); });
    ws.send(JSON.stringify({ t: "hello", v: 1, token: h.registry!.token, client: "mod" }));
    await until(() => recs.some((r) => r.t === "snapshot"), 5000, "welcome and snapshot through the tunnel");
    assert.deepEqual(recs.slice(0, 2).map((r) => r.t), ["welcome", "snapshot"]);

    ws.send(JSON.stringify({ t: "req", id: "w1", op: "send", text: "Look around the repo" }));
    const res = await until(() => recs.find((r) => r.t === "res" && r.id === "w1"), 5000, "the send's answer");
    assert.equal(res.ok, true, JSON.stringify(res));
    await h.client.waitFor((c) => idle(c) && c.items.some((i: Rec) => i.kind === "tool"), 15_000, "the turn ends");
    await until(() => recs.some((r) => (r.upsert ?? []).some((i: Rec) => i.kind === "assistant")), 5000, "the answer came through the tunnel");

    ws.close();
    const code = await Promise.race([t.exited, sleep(5000).then(() => "still running")]);
    assert.equal(code, 0, `the idle tunnel exits: ${t.stderr()}`);
    assert.equal(existsSync(stateFile), false, "and takes its state file with it");
  } finally {
    ws?.terminate();
    t.proc.kill();
    await h.stop();
  }
});

test("a host that is gone: the connection closes, and the tunnel stays for the next one until it is stopped", async () => {
  const dir = (await startHost({ name: "tunnel-dead" }).then(async (h) => { await h.stop(); return h.dir; }));
  const stateFile = join(dir, "tunnels", "m1-dead.json");
  const port = await deadPort();
  const t = startTunnel(port, stateFile, 60_000);
  try {
    const state = await until(() => readState(stateFile), 10_000, `the tunnel's state file (${t.stderr()})`);
    const ws = new WebSocket(`ws://127.0.0.1:${state.port}/`);
    const outcome = await new Promise<string>((r) => { ws.once("open", () => r("open")); ws.once("error", () => r("error")); ws.once("close", () => r("close")); });
    assert.notEqual(outcome, "open", "no host at the far end: no WebSocket");
    await sleep(300);
    assert.equal(t.proc.exitCode, null, "the tunnel keeps listening");
    assert.match(t.stderr(), /exited 2: herdr-chat-host: 127\.0\.0\.1:\d+: /, "and says why the far end gave up");
    t.proc.kill("SIGTERM");
    assert.equal(await t.exited, 0);
    assert.equal(existsSync(stateFile), false);
  } finally {
    t.proc.kill();
  }
});
