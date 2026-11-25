// Drives `omp --mode rpc --no-session` and records every stdout record (rpc_chunk runs reassembled).
// A quick look at the wire; the fixtures come from tests/fixtures/omp/record.ts.
//   node host/providers/omp/research/probe.mjs ["prompt text"]      (OMP_BIN, PROBE_MODEL, PROBE_CWD)
import { spawn } from "node:child_process";
import { writeFileSync, appendFileSync } from "node:fs";
const out = new URL("./events.jsonl", import.meta.url).pathname;
writeFileSync(out, "");
const model = process.env.PROBE_MODEL ?? "anthropic/claude-haiku-4-5";
const child = spawn(process.env.OMP_BIN ?? "omp", ["--mode", "rpc", "--no-session", "--model", model, "--thinking", "low", "--no-title"],
  { cwd: process.env.PROBE_CWD ?? process.cwd(), stdio: ["pipe", "pipe", "pipe"] });
let buf = Buffer.alloc(0), stderr = "";
const waiters = new Map();
const t0 = Date.now();
let chunk = null; // {id, parts}
child.stderr.on("data", (d) => (stderr += d));
child.stdout.on("data", (d) => {
  buf = Buffer.concat([buf, d]);
  let i;
  while ((i = buf.indexOf(10)) >= 0) {
    const line = buf.subarray(0, i).toString("utf8").replace(/\r$/, "");
    buf = buf.subarray(i + 1);
    if (!line) continue;
    let rec = JSON.parse(line);
    if (rec.type === "rpc_chunk") {
      if (!chunk || chunk.id !== rec.chunkId) chunk = { id: rec.chunkId, parts: [] };
      chunk.parts.push(Buffer.from(rec.data, "base64"));
      if (chunk.parts.length < rec.count) continue;
      rec = JSON.parse(Buffer.concat(chunk.parts).toString("utf8"));
      chunk = null;
    }
    appendFileSync(out, JSON.stringify({ t: Date.now() - t0, ...rec }) + "\n");
    if (rec.type === "response" && waiters.has(rec.id)) { waiters.get(rec.id)(rec); waiters.delete(rec.id); }
    if (rec.type === "session_settled") waiters.get("settled")?.(rec);
  }
});
let n = 0;
const send = (cmd) => new Promise((res) => { const id = `p${++n}`; waiters.set(id, res); child.stdin.write(JSON.stringify({ id, ...cmd }) + "\n"); });
const settled = () => new Promise((res) => waiters.set("settled", res));
console.log("negotiate:", JSON.stringify((await send({ type: "negotiate_protocol", protocolVersion: 2 })).data));
const state = await send({ type: "get_state" });
const cmds = await send({ type: "get_available_commands" });
const levels = await send({ type: "get_available_thinking_levels" });
console.log("state:", JSON.stringify({ model: state.data?.model?.id, thinking: state.data?.thinkingLevel, isStreaming: state.data?.isStreaming, isSettled: state.data?.isSettled }));
console.log("levels:", JSON.stringify(levels.data?.levels));
console.log("commands:", cmds.data.commands.length, "by source:", JSON.stringify(cmds.data.commands.reduce((a, c) => ((a[c.source] = (a[c.source] || 0) + 1), a), {})));
const s = settled();
const p = await send({ type: "prompt", message: process.argv[2] ?? "Use the bash tool to run `echo hello-from-rpc`, then reply with just the word done." });
console.log("prompt response:", JSON.stringify(p.data ?? null));
await Promise.race([s, new Promise((r) => setTimeout(r, 90000))]);
child.stdin.end();
// omp can take a while to wind down after stdin closes; don't wait for it past 5 s.
await Promise.race([new Promise((r) => child.on("exit", r)), new Promise((r) => setTimeout(r, 5000)).then(() => child.kill("SIGTERM"))]);
writeFileSync(new URL("./stderr.txt", import.meta.url).pathname, stderr);
console.log("done; events in", out, "; stderr bytes:", stderr.length);
