// Starts the real host on the omp provider with fake-omp (scripted or replaying a fixture), or with a real omp.
import { join } from "node:path";
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { Host, ROOT } from "../host/harness.ts";

export const FAKE_OMP = join(ROOT, "tests", "fake-omp", "fake-omp.mjs");
export const OMP_FIXTURES = join(ROOT, "tests", "fixtures", "omp");

export type OmpHostOptions = {
  name: string;
  /** An inline scenario (fake-omp's scenario mode). */
  scenario?: object;
  /** A fixture in tests/fixtures/omp/. */
  replay?: string;
  speed?: number;
  session?: string;
  dir?: string;
  cwd?: string;
  chat?: string;
  /** A real omp (LIVE tests): its command. */
  agent?: string;
  /** omp's own arguments (after `--`). */
  args?: string[];
  env?: Record<string, string>;
  /** Physical frame size fake-omp chunks above (protocol v2). Small by default, so replays exercise the chunk decoder. */
  frameBytes?: number;
};

export class OmpHost extends Host {
  get ompLog(): string {
    return join(this.dir, "omp-commands.jsonl");
  }
  /** What the host sent to fake-omp. */
  ompCommands(type?: string): any[] {
    if (!existsSync(this.ompLog)) return [];
    return readFileSync(this.ompLog, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((c) => !type || c.type === type);
  }
}

export async function ompHost(o: OmpHostOptions): Promise<OmpHost> {
  const fake = !o.agent || o.agent === FAKE_OMP;
  const h = new OmpHost({
    name: o.name, provider: "omp", agent: o.agent ?? FAKE_OMP, piArgs: o.args ?? (fake ? ["--session-dir", "SESSIONS"] : []),
    ...(o.dir ? { dir: o.dir } : {}), ...(o.cwd ? { cwd: o.cwd } : {}), ...(o.chat ? { chat: o.chat } : {}), ...(o.session ? { session: o.session } : {}),
  });
  if (h.opts.piArgs) h.opts.piArgs = h.opts.piArgs.map((a) => (a === "SESSIONS" ? join(h.dir, "sessions") : a));
  const env: Record<string, string> = fake ? { FAKE_OMP_LOG: h.ompLog, FAKE_OMP_SPEED: String(o.speed ?? 4), FAKE_OMP_FRAME_BYTES: String(o.frameBytes ?? 16 * 1024) } : {};
  if (o.scenario) {
    const path = join(h.dir, "omp-scenario.json");
    writeFileSync(path, JSON.stringify(o.scenario));
    env.FAKE_OMP_SCENARIO = path;
  }
  if (o.replay) env.FAKE_OMP_REPLAY = join(OMP_FIXTURES, o.replay);
  h.opts.env = { ...env, ...(o.env ?? {}) };
  await h.start();
  return h;
}
