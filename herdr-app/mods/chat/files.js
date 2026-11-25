// Open a file a tool touched (visual-v2.md §6, "clickable file paths"):
// 1. herdr-nvim installed (mods/herdr-nvim/bin/herdr-nvim, as gitview's
//    nvim.js finds it): `herdr-nvim open --tab <tab> --space <space> <file>:<line>`;
// 2. else $EDITOR (the login shell's; vi without one) in a terminal pane
//    of the chat's tab (beside it, like the TUI hand-off), in the chat's folder.
// A chat whose agent is on another machine (remote.js): the file is there, so
// is the editor (that machine's $EDITOR, in a terminal there); herdr-nvim is
// this computer's, not used.

import { appHome, exec, hc, readTextFile } from "herdr";
import { bare } from "./remote.js";

const editors = new Map(); // machine (null: this computer) → the editor's argv

async function herdrNvim() {
  const bin = `${appHome()}/mods/herdr-nvim/bin/herdr-nvim`;
  try {
    return (await readTextFile(bin)) !== null ? bin : null;
  } catch {
    return null;
  }
}

async function editorArgv(machine) {
  if (editors.has(machine)) return editors.get(machine);
  let ed = "";
  try {
    ed = (await exec("/bin/sh", ["-lc", 'printf %s "${VISUAL:-$EDITOR}"'], machine ? { on: machine } : undefined)).stdout.trim();
  } catch {}
  editors.set(machine, (ed || "vi").split(/\s+/).filter(Boolean));
  return editors.get(machine);
}

// {path (absolute), line, cwd, tab, space, machine} → {how: "herdr-nvim" | "editor", terminal?}
export async function openFile(o) {
  const machine = o.machine ?? null;
  const nvim = machine ? null : await herdrNvim();
  if (nvim && o.tab) {
    const args = ["open", "--tab", String(o.tab)];
    if (o.space) args.push("--space", String(o.space));
    args.push(`${o.path}:${o.line || 1}`);
    const r = await exec(nvim, args, { cwd: o.cwd });
    if (r.code === 0) return { how: "herdr-nvim" };
  }
  const ed = await editorArgv(machine);
  const argv = /(^|\/)(n?vim?|vi|hx|helix|kak|micro|nano|emacs)$/.test(ed[0]) ? [...ed, `+${o.line || 1}`, o.path] : [...ed, o.path];
  if (!o.space || !o.tab) throw new Error("no tab to open the editor in");
  // (Labels on another machine name its spaces and tabs bare.)
  const r = await hc(["run", ...(machine ? ["--on", machine] : []), "--bg", "--json", "--no-parent", "--cwd", o.cwd ?? "/", "--label", `herdr.space=${bare(o.space, machine)}`,
    "--label", `herdr.tab=${bare(o.tab, machine)}`, "--label", "herdr-chat.editor=1", "--", ...argv]);
  if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim() || "hc run failed");
  return { how: "editor", terminal: JSON.parse(r.stdout).address, argv };
}
