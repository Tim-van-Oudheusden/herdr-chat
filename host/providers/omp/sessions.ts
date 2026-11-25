// omp session files: where they live (as omp resolves its agent dir and a
// cwd's bucket) and what /resume shows of each (omp docs/session.md).
import { statSync, openSync, readSync, closeSync } from "node:fs";
import { join, resolve, relative, isAbsolute } from "node:path";
import { homedir, tmpdir } from "node:os";
import { eachLine, realDir, subdirs } from "../../jsonl.ts";
import type { SessionInfo, SessionScope } from "../types.ts";
import { skillTyped } from "./content.ts";

const tilde = (p: string) => p.replace(/^~(?=\/|$)/, homedir());

function flag(args: string[], name: string): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === name) return args[i + 1];
    if (a.startsWith(`${name}=`)) return a.slice(name.length + 1);
  }
  return undefined;
}

/**
 * omp's agent dir, as omp resolves it: a named profile (`--profile`,
 * $OMP_PROFILE, else $PI_PROFILE) lives in <root>/profiles/<name>/agent;
 * the default profile honours $PI_CODING_AGENT_DIR; <root> is ~/<$PI_CONFIG_DIR or .omp>.
 */
export function agentDir(args: string[] = []): string {
  const root = join(homedir(), process.env.PI_CONFIG_DIR || ".omp");
  const profile = flag(args, "--profile") ?? (process.env.OMP_PROFILE !== undefined ? process.env.OMP_PROFILE : process.env.PI_PROFILE);
  if (profile) return join(root, "profiles", profile, "agent");
  return process.env.PI_CODING_AGENT_DIR ? tilde(process.env.PI_CODING_AGENT_DIR) : join(root, "agent");
}

/**
 * A cwd's session bucket name: the canonical path, `-<relative>` under home,
 * `-tmp-<relative>` under the temp root, else `--<absolute>--`, separators as `-`.
 */
export function bucketName(cwd: string): string {
  const real = realDir(resolve(cwd));
  const enc = (p: string) => p.replace(/[/\\:]/g, "-");
  const under = (root: string) => {
    const rel = relative(realDir(root), real);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel)) ? rel : null;
  };
  const home = under(homedir());
  if (home !== null) return `-${enc(home)}`;
  const tmp = under(tmpdir());
  if (tmp !== null) return `-tmp-${enc(tmp)}`;
  return `--${enc(real.replace(/^[/\\]/, ""))}--`;
}

/**
 * The folders /resume reads: a custom session dir (`--session-dir`,
 * $PI_CODING_AGENT_SESSION_DIR) holds them flat; else this cwd's bucket under
 * <agent dir>/sessions, or with `all` every bucket.
 */
export function sessionDirs(cwd: string, args: string[], scope: SessionScope): string[] {
  const custom = flag(args, "--session-dir") ?? process.env.PI_CODING_AGENT_SESSION_DIR;
  if (custom) return [resolve(cwd, tilde(custom))];
  const root = join(agentDir(args), "sessions");
  return scope === "all" ? subdirs(root) : [join(root, bucketName(cwd))];
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.filter((b) => b?.type === "text").map((b) => b.text).join(" ");
  return "";
}

/**
 * The name (the 256-byte title slot, else the header's title), the folder and
 * the first user message. Files may begin with the header (legacy). Other
 * messages are counted from their first bytes; OMP-only entries are skipped.
 */
export function describeSession(path: string): SessionInfo | null {
  let st;
  try {
    st = statSync(path);
  } catch {
    return null;
  }
  let name: string | null = null;
  let first = "";
  let count = 0;
  let header = false;
  let cwd: string | null = null;
  const take = (line: string) => {
    let e: any;
    try {
      e = JSON.parse(line);
    } catch {
      return;
    }
    if (e.type === "title") {
      if (typeof e.title === "string" && e.title) name = e.title;
    } else if (e.type === "session") {
      header = true;
      if (typeof e.cwd === "string" && e.cwd) cwd = e.cwd;
      if (!name && typeof e.title === "string" && e.title) name = e.title;
    } else if (e.type === "message" && (e.message?.role === "user" || e.message?.role === "assistant")) {
      count++;
      if (e.message.role === "user" && !first) first = textOf(e.message.content).slice(0, 200);
    } else if (e.type === "custom_message" && e.customType === "skill-prompt") {
      count++;
      if (!first) first = skillTyped(e.details) ?? "";
    }
  };
  const want = (head: string) => {
    const type = /^\{"type":"([a-z_]+)"/.exec(head)?.[1];
    if (type === undefined) return true;
    if (type === "custom_message" && head.includes('"customType":"skill-prompt"')) {
      if (first) count++;
      return !first;
    }
    if (type !== "message") return type === "session" || type === "title";
    const role = /"role":"(\w+)"/.exec(head)?.[1];
    if (role === undefined) return true;
    if (role === "assistant" || (role === "user" && first)) count++;
    return role === "user" && !first;
  };
  try {
    eachLine(path, want, take);
  } catch {
    return null;
  }
  if (!header) return null;
  return { path, name, firstMessage: first, modified: st.mtimeMs, messageCount: count, cwd };
}

/** The session id in a file's header (null when it has none). The header is the first or second line (after the title slot). */
export function sessionId(path: string): string | null {
  let fd: number | null = null;
  try {
    fd = openSync(path, "r");
    const buf = Buffer.alloc(8192);
    const head = buf.subarray(0, readSync(fd, buf, 0, buf.length, 0)).toString("utf8");
    for (const line of head.split("\n").slice(0, 2)) {
      try {
        const e = JSON.parse(line);
        if (e?.type === "session" && typeof e.id === "string") return e.id;
      } catch {}
    }
  } catch {
  } finally {
    if (fd !== null) closeSync(fd);
  }
  return null;
}
