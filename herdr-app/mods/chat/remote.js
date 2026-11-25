// A chat with an agent on another machine (`hc machine`: an SSH server, a VM).
// The host runs there, next to the agent and its session files
// (`hc run --on <machine>`), with that machine's herdr-chat and state dir. The
// mod still connects to 127.0.0.1 here: a tunnel (`herdr-chat-host tunnel`, in a
// paneless herdr-core terminal of this computer) carries each connection over
// the machine's transport (ssh to its target, or its `--via` command) to
// `herdr-chat-host pipe` there, which joins it to the host's WebSocket port.
//
// Ids: the app names that machine's spaces, tabs, panes and terminals
// `<machine>/<id>`; its own layout document and labels use the bare `<id>`.
// getDoc/setDoc (hostpane.js) translate whole documents; qualify/bare one id.
//
// What this computer's install found (mods/chat/config.json: the host, node, the
// agents' paths) is never sent there. The person's settings.json says what the
// machine has, under "machines": {"<name>": {"host", "node", "env", "<agent>":
// {"command", "args", "env", "tui"}}}: "host" is required (a clone or an
// unpacked release there; README "Other machines").

import { appHome, exec, hc, readTextFile } from "herdr";
import { settingsPath, stateDir } from "./paths.js";

const q = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;

/** The machine of another computer's address ("box" for "box/t7"), null for one of this computer's. */
export function machineOf(address) {
  const s = String(address ?? ""), at = s.indexOf("/");
  return at > 0 ? s.slice(0, at) : null;
}

/** `<machine>/<id>` for a machine's bare id (as is for this computer, or one already qualified). */
export function qualify(id, machine) {
  return machine && id != null && !String(id).includes("/") ? `${machine}/${id}` : id;
}

/** The bare id a machine's document and labels use. */
export function bare(id, machine) {
  const s = String(id ?? "");
  return machine && s.startsWith(`${machine}/`) ? s.slice(machine.length + 1) : id;
}

/** Every id in a layout document (spaces, tabs, nodes, their terminals) through `f`, in place. */
export function mapDocIds(doc, f) {
  const node = (n) => {
    if (!n) return;
    if (n.id != null) n.id = f(n.id);
    if (n.content?.terminal != null) n.content.terminal = f(n.content.terminal);
    for (const c of n.children ?? []) node(c);
  };
  for (const s of doc?.spaces ?? []) {
    if (s.id != null) s.id = f(s.id);
    for (const t of s.tabs ?? []) {
      if (t.id != null) t.id = f(t.id);
      node(t.root);
    }
  }
  return doc;
}

async function readJson(path, on = null) {
  try {
    return JSON.parse((await readTextFile(path, on ? { on } : undefined)) ?? "{}") ?? {};
  } catch {
    return {};
  }
}

// machine → {at, value}: what is there, asked again after a minute. Only a settled answer is shared:
// a host call belongs to the view that made it, and one that closes first leaves it unsettled forever
// (the app logs "stranded script tasks"), so two views asking at once each ask.
const setups = new Map();

/**
 * What a machine has: {home, stateDir, appHome, host, node, transport}. `transport(line)` is the argv
 * that runs a shell line there. Throws with what to do when it has no herdr-chat or no transport.
 */
export async function machineSetup(machine) {
  const hit = setups.get(machine);
  if (hit && Date.now() - hit.at < 60000) return hit.value;
  const value = await (async () => {
    const mine = (await readJson(settingsPath())).machines?.[machine] ?? {};
    const host = typeof mine.host === "string" && mine.host ? mine.host : null;
    const how = `name it in settings.json: "machines": {"${machine}": {"host": "<herdr-chat there>/bin/herdr-chat-host"}} (README "Other machines")`;
    if (!host) throw new Error(`The agent runs on ${machine}, and so does its chat's host: install herdr-chat there and ${how}`);
    // Its home, and its app home as a sub-agent's host there finds it (host/subagent.ts appHomeOf), so a chat
    // started here and a sub-agent started there keep their registries in one place.
    const r = await exec("/bin/sh", ["-c", 'printf "%s\\n%s" "$HOME" "${HERDR_APP_HOME:-$HOME/.config/herdr-app}"'], { on: machine });
    const [home, machineAppHome] = r.code === 0 ? r.stdout.split("\n") : [];
    if (!home || !machineAppHome) throw new Error(`can't reach ${machine}: ${(r.stderr || r.stdout).trim() || "no home there"}`);
    if ((await readTextFile(host, { on: machine }).catch(() => null)) === null) throw new Error(`${machine} has no ${host}: ${how}`);
    const listed = await hc(["machine", "ls", "--json"]);
    let m = null;
    try { m = JSON.parse(listed.stdout).machines?.find((x) => x.name === machine) ?? null; } catch {}
    if (!m?.target) throw new Error(`hc machine ls has no ${machine}`);
    // An ssh target may carry a port (`can@10.0.0.7:2222`): ssh takes that as a URI.
    const sshTarget = /^[^[]*:\d+$/.test(m.target) ? `ssh://${m.target}` : m.target;
    const transport = m.via ? (line) => ["/bin/sh", "-c", `${m.target} ${q(line)}`] : (line) => ["ssh", "-T", "-o", "BatchMode=yes", sshTarget, line];
    const node = typeof mine.node === "string" && mine.node ? mine.node : null;
    return { home, stateDir: `${machineAppHome}/data/herdr-chat`, appHome: machineAppHome, host, node, transport, settings: mine };
  })();
  setups.set(machine, { at: Date.now(), value });
  return value;
}

/** One agent's command, args, env and tui on the machine (settings.json "machines"; none of this computer's). */
export function machineAgent(setup, id) {
  const all = setup.settings ?? {};
  const a = all[id] && typeof all[id] === "object" ? all[id] : {};
  const list = (v) => (Array.isArray(v) ? v.map(String) : typeof v === "string" && v ? [v] : null);
  return {
    command: typeof a.command === "string" && a.command ? a.command : null,
    args: list(a.args) ?? [],
    env: { ...(all.env ?? {}), ...(a.env ?? {}) },
    tui: list(a.tui),
  };
}

/** `herdr-chat-host <args>` on the machine, through `exec` (tui-session, tui-busy). */
export async function hostExec(machine, args, timeout) {
  const s = await machineSetup(machine);
  return exec("/usr/bin/env", [...(s.node ? [`HERDR_CHAT_NODE=${s.node}`] : []), s.host, ...args], { on: machine, ...(timeout ? { timeout } : {}) });
}

/** A chat's registry entry on the machine, or null. */
export async function readRemoteRegistry(machine, chat) {
  const s = await machineSetup(machine);
  try {
    const text = await readTextFile(`${s.stateDir}/chats/${chat}.json`, { on: machine });
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

// tunnel file → when a view started it (two chats on one host start one tunnel). Nothing else is shared
// (see setups): the view that starts it awaits its own `hc run`, and every caller waits for the state file
// with its own cx. A start that isn't listening 15 s later may be tried again.
const launched = new Map();

/**
 * The local port that reaches the machine's 127.0.0.1:`remotePort`: a running tunnel's, else one
 * started now (in a paneless terminal of this computer, ended by itself once idle). `cfg`: this
 * computer's install (readConfig: its host and node run the tunnel); `cx`: the caller's, to wait.
 */
export async function tunnelPort(machine, remotePort, { cfg, cx, log }) {
  const file = `${stateDir()}/tunnels/${machine}-${remotePort}.json`;
  const cur = await readJson(file);
  if (cur.pid && cur.port && cur.remotePort === remotePort && (await exec("kill", ["-0", String(cur.pid)])).code === 0) return cur.port;
  if (Date.now() - (launched.get(file) ?? 0) > 15000) {
    launched.set(file, Date.now());
    try {
      if (!cfg.host) throw new Error('mods/chat/config.json has no "host"');
      const s = await machineSetup(machine);
      const line = ["/usr/bin/env", ...(s.node ? [`HERDR_CHAT_NODE=${s.node}`] : []), s.host, "pipe", "--port", String(remotePort)].map(q).join(" ");
      const r = await hc(["run", "--bg", "--json", "--no-parent", "--rm", "--cwd", appHome(), "--label", `herdr-chat.tunnel=${machine}:${remotePort}`,
        "--", "/usr/bin/env", ...(cfg.node ? [`HERDR_CHAT_NODE=${cfg.node}`] : []), cfg.host, "tunnel", "--port", String(remotePort), "--state-file", file,
        "--", ...s.transport(line)]);
      if (r.code !== 0) throw new Error(`the tunnel to ${machine} didn't start: ${(r.stderr || r.stdout).trim()}`);
      log(`tunnel to ${machine}:${remotePort}: ${r.stdout.trim()}`);
    } catch (e) {
      launched.delete(file); // tried again by the next caller
      throw e;
    }
  }
  for (let i = 0; i < 100; i++) {
    const t = await readJson(file);
    if (t.port && t.remotePort === remotePort && t.pid !== cur.pid) return t.port;
    await cx.sleep(100);
  }
  throw new Error(`the tunnel to ${machine} didn't listen within 10 s`);
}
