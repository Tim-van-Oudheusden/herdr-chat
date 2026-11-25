// omp's built-in tools (omp docs/tools/*.md) for the shared classifier, and
// what only omp sends: edits as hashline patches (`[path#TAG]` then ops, so no
// `path` argument and no old/new strings), and their result's numbered diff.
import { firstLine, str } from "../../tools.ts";
import type { ToolMap, Presented, Rel } from "../../tools.ts";
import type { ToolDetail } from "../types.ts";

type Rec = Record<string, any>;

/** `[path#TAG]` → path (a hashline section header, or a write target given that way). */
function unwrapHeader(s: string): string {
  const m = /^\[(.+?)(?:#[^\]#]*)?\]$/.exec(s.trim());
  return m ? m[1]! : s;
}

/** The files a hashline `edit` input names, in order: each section starts with `[path#TAG]`. */
export function hashlinePaths(input: string): string[] {
  const out: string[] = [];
  for (const line of input.split("\n")) {
    const m = /^\[([^\]\n]+?)(?:#[0-9A-Za-z?]*)?\]\s*$/.exec(line);
    if (m && !out.includes(m[1]!)) out.push(m[1]!);
  }
  return out;
}

/**
 * omp's edit diff (`-N|old`, `+N|new`, ` N|context`; N is the old file's line
 * for `-` and context, the new file's for `+`; a line that isn't one of these
 * separates hunks) → a unified diff.
 */
export function unifiedFromNumbered(path: string, diff: string): string | null {
  const out = [`--- ${path}`, `+++ ${path}`];
  let delta = 0; // new line − old line, after the lines so far
  let hunk: { oldStart: number; newStart: number; oldLines: number; newLines: number; lines: string[] } | null = null;
  const close = () => {
    if (!hunk || !hunk.lines.length) return;
    out.push(`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`, ...hunk.lines);
    hunk = null;
  };
  for (const line of diff.split("\n")) {
    const m = /^([ +-])\s*(\d+)\|(.*)$/.exec(line);
    if (!m) {
      close();
      continue;
    }
    const [, sign, n, text] = m as unknown as [string, string, string, string];
    const num = Number(n);
    const oldAt = sign === "+" ? num - delta : num;
    if (!hunk) hunk = { oldStart: oldAt, newStart: oldAt + delta, oldLines: 0, newLines: 0, lines: [] };
    hunk.lines.push(`${sign}${text}`);
    if (sign !== "+") hunk.oldLines++;
    if (sign !== "-") hunk.newLines++;
    if (sign === "+") delta++;
    else if (sign === "-") delta--;
  }
  close();
  return out.length > 2 ? out.join("\n") + "\n" : null;
}

function present(name: string, a: Rec, rel: Rel): Presented | null {
  switch (name) {
    case "edit": {
      const input = str(a.input);
      if (input === undefined) return null;
      const paths = hashlinePaths(input);
      const path = paths[0] ?? "";
      const more = paths.length > 1 ? ` (+${paths.length - 1})` : "";
      return { title: `Edit ${rel(path)}${more}`.trim(), detail: { type: "edit", path, diff: null } };
    }
    case "write": {
      const raw = str(a.path);
      if (raw === undefined || !raw.startsWith("[")) return null;
      const path = unwrapHeader(raw);
      const content = str(a.content);
      return { title: `Write ${rel(path)}`, detail: { type: "write", path, ...(content !== undefined ? { bytes: Buffer.byteLength(content) } : {}) } };
    }
    case "ast_edit": {
      const paths: string[] = Array.isArray(a.paths) ? a.paths.filter((p: unknown) => typeof p === "string") : [];
      const path = paths[0] ?? "";
      const more = paths.length > 1 ? ` (+${paths.length - 1})` : "";
      return { title: `Rewrite ${rel(path)}${more}`.trim(), detail: { type: "edit", path, diff: null } };
    }
    case "ast_grep": {
      const query = str(a.pat);
      const p = str(a.path);
      return { title: `Find ${query ?? ""}${p ? ` in ${rel(p)}` : ""}`.trim(), detail: { type: "search", tool: name, ...(query !== undefined ? { query } : {}), ...(p !== undefined ? { path: p } : {}) } };
    }
    case "glob": {
      const p = str(a.path) ?? ".";
      return { title: `Find ${rel(p)}`, detail: { type: "search", tool: name, path: p } };
    }
    case "eval": {
      const code = str(a.code) ?? "";
      const label = str(a.title) || firstLine(code, 80);
      return { title: `Eval (${str(a.language) ?? "code"}) ${label}`.trim(), detail: { type: "bash", command: code } };
    }
    case "task": {
      const tasks: Rec[] = Array.isArray(a.tasks) ? a.tasks : [a];
      const names = tasks.map((t) => str(t?.name) ?? str(t?.agent)).filter(Boolean);
      const what = names.length ? names.join(", ") : firstLine(str(tasks[0]?.task) ?? "", 80);
      return { title: `Task ${what}`.trim(), detail: { type: "generic", tool: name } };
    }
  }
  return null;
}

export const OMP_TOOLS: ToolMap = {
  names: {
    bash: "bash", eval: "bash",
    read: "read",
    edit: "edit", ast_edit: "edit",
    write: "write",
    grep: "search", ast_grep: "search", glob: "search", find: "search",
    web_search: "web_search",
  },
  present,
  applyResult(detail: ToolDetail, result: Rec, cwd: string): ToolDetail | undefined {
    if (detail.type !== "edit") return undefined;
    const d: Rec = result.details && typeof result.details === "object" ? result.details : {};
    const diff = str(d.diff);
    if (!diff) return undefined;
    const path = str(d.path) ?? detail.path;
    const shown = path && cwd && path.startsWith(cwd + "/") ? path.slice(cwd.length + 1) : path;
    const unified = unifiedFromNumbered(shown, diff);
    return unified ? { ...detail, path, diff: unified } : undefined;
  },
};
