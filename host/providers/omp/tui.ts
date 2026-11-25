// An omp TUI's session, for Continue as chat. omp writes a breadcrumb per
// terminal (<agent dir>/terminal-sessions/<terminal id>: its cwd, then its
// session file, then optional `fresh` / `cwdstat` lines; the id is the TTY's
// path, `/dev/pts/3` → `pts-3`). The TUI's model and thinking level are the
// last `model_change` and `thinking_level_change` entries of that file.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { TuiQuery, TuiSession } from "../tui.ts";
import { agentDir } from "./sessions.ts";

/** The process's terminal as omp names it (`pts-3`, `ttys003`), or null. */
function terminalId(pid: number): string | null {
  try {
    const tty = execFileSync("ps", ["-o", "tty=", "-p", String(pid)], { encoding: "utf8", timeout: 3000 }).trim();
    if (!tty || tty === "?" || tty === "??") return null;
    return tty.replace(/^\/dev\//, "").replace(/\//g, "-");
  } catch {
    return null;
  }
}

/** The session file a breadcrumb names, or null; throws when it names a session with nothing in it yet. */
export function breadcrumbSession(path: string): string | null {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  const [, file, ...rest] = text.split("\n");
  if (!file) return null;
  if (existsSync(file)) return file;
  if (rest.includes("fresh")) throw new Error("this omp session has no messages yet: send one in omp first, or start a new chat");
  return null;
}

/** The TUI's model ("provider/id") and thinking level, from its session file. */
export function sessionChoices(file: string): { model: string | null; thinking: string | null } {
  let model: string | null = null, thinking: string | null = null;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.includes("model_change") && !line.includes("thinking_level_change")) continue;
    try {
      const e = JSON.parse(line);
      if (e.type === "model_change" && typeof e.model === "string" && e.model) model = e.model;
      if (e.type === "thinking_level_change" && typeof e.thinkingLevel === "string" && e.thinkingLevel) thinking = e.thinkingLevel;
    } catch {}
  }
  return { model, thinking };
}

export function ompTuiSession(q: TuiQuery): TuiSession {
  let session = q.label;
  if (!session) {
    const id = terminalId(q.pid);
    if (!id) throw new Error("can't tell which terminal this omp runs in (no TTY), so not which session it has open");
    session = breadcrumbSession(join(agentDir(), "terminal-sessions", id));
    if (!session) throw new Error(`omp left no record of its session for terminal ${id}: send a message in omp first, or /resume it in a new chat`);
  }
  let choices;
  try {
    choices = sessionChoices(session);
  } catch {
    throw new Error(`can't read the session file ${session}`);
  }
  const { model, thinking } = choices;
  return { session, model, thinking, args: [...(model ? ["--model", model] : []), ...(thinking ? ["--thinking", thinking] : [])] };
}
