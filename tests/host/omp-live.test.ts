// Smoke test against the real `omp --mode rpc` (the user's login and config). Run only with LIVE=1.
// claude-haiku-4-5 at thinking low, a temp cwd, `--approval-mode always-ask` so the command needs approval.
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { idle } from "./harness.ts";
import { ompHost } from "../fake-omp/host.ts";

const LIVE = process.env.LIVE === "1";
const MODEL = ["--model", "anthropic/claude-haiku-4-5", "--thinking", "low"];

test("live: real omp — a bash call approved from its card, the answer, then a fork", { skip: !LIVE, timeout: 240_000 }, async () => {
  const h = await ompHost({ name: "omp-live", agent: process.env.OMP_BIN ?? "omp", args: [...MODEL, "--approval-mode", "always-ask"] });
  try {
    const c = h.client;
    writeFileSync(join(h.cwd, "README.md"), "# live smoke\n");
    await c.waitFor(idle, 60_000, "omp started");
    await c.waitFor((x) => !!x.state.agentVersion, 15_000, "omp version read");
    assert.equal(c.state.model.id, "claude-haiku-4-5");
    assert.ok(c.state.capabilities.thinkingLevels.includes("low"));

    await c.req("send", { text: "Use the bash tool to run exactly `touch live-ok.txt && echo live-ok`, then reply with just the word done." });
    await c.waitFor((x) => x.state.dialog?.method === "permission", 120_000, "approval card");
    const d = c.state.dialog;
    assert.equal(d.title, "Allow bash?");
    assert.ok(d.choices.some((x: any) => x.kind === "allow") && d.choices.some((x: any) => x.kind === "deny"));
    await c.req("dialog_answer", { dialog: d.id, choice: d.choices.find((x: any) => x.kind === "allow").id });
    await c.waitFor((x) => idle(x) && x.items.some((i) => i.kind === "assistant" && /done/i.test(i.text) && !i.streaming), 120_000, "answer");
    const tool = c.items.find((i) => i.kind === "tool" && /live-ok/.test(i.title));
    assert.equal(tool.status, "done");
    assert.equal(tool.detail.exitCode, 0);
    assert.match(tool.output, /live-ok/);
    assert.ok(existsSync(join(h.cwd, "live-ok.txt")), "the command ran in the chat's cwd");
    await c.waitFor((x) => x.state.usage?.contextTokens > 0, 10_000, "usage");
    assert.match(c.state.sessionFile, /\.jsonl$/);
    const first = c.state.sessionFile;

    const { points } = await c.req("fork_points", {});
    assert.equal(points.length, 1);
    const forked = await c.req("fork", { point: points[0].id });
    assert.match(forked.text, /touch live-ok\.txt/);
    await c.waitFor((x) => x.state.sessionFile && x.state.sessionFile !== first, 15_000, "the fork's session");
    h.artifact("omp-live");
  } finally {
    await h.stop();
  }
});
