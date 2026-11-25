// A chat whose host runs on another machine (`hc machine`): the mod's WebSocket
// still goes to 127.0.0.1 here, and these two carry it there.
//
// - `tunnel` runs here, in a background herdr-core terminal the mod starts. It
//   listens on 127.0.0.1 (a free port) and, for each connection, runs the
//   machine's transport (its argv: ssh to the machine's target, or its --via
//   command), with `pipe` as the command on the far side. Its state file says
//   where it listens; it removes it and exits once no connection has been open
//   for `idleMs` (the chat closed, or the window did: the mod starts it again).
// - `pipe` runs on the machine: stdin/stdout joined to 127.0.0.1:<port> there,
//   the host's WebSocket port. It ends when either side does.
//
// Neither looks at the bytes: the host's hello token still guards the link.
// (Executor-form promises: a release runs on Node 20, which has no Promise.withResolvers.)

import { spawn } from "node:child_process";
import { createConnection, createServer } from "node:net";
import type { Socket } from "node:net";
import { readFileSync, unlinkSync } from "node:fs";
import { atomicWrite } from "./registry.ts";

export type TunnelState = { pid: number; port: number; remotePort: number };

/** stdin/stdout ↔ 127.0.0.1:port. Resolves when the connection ends. */
export function pipe(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const sock = createConnection({ host: "127.0.0.1", port });
    let open = false;
    sock.once("connect", () => {
      open = true;
      process.stdin.pipe(sock);
      sock.pipe(process.stdout);
    });
    process.stdin.once("end", () => sock.end());
    sock.once("error", (e) => (open ? resolve() : reject(new Error(`127.0.0.1:${port}: ${e.message}`))));
    sock.once("close", () => resolve());
  });
}

type TunnelOpts = {
  remotePort: number;
  stateFile: string;
  /** Run once per connection; its stdin/stdout are the connection's other end. */
  argv: string[];
  idleMs: number;
  log: (msg: string) => void;
};

/** Listens until idle; resolves with the port once it listens. `done` resolves when it has stopped. */
export function tunnel(o: TunnelOpts): Promise<{ port: number; done: Promise<void> }> {
  const [cmd, ...args] = o.argv;
  if (!cmd) return Promise.reject(new Error("tunnel needs the transport's argv after --"));
  const open = new Set<Socket>();
  let idleTimer: NodeJS.Timeout | undefined;
  let finish!: () => void;
  const done = new Promise<void>((r) => (finish = r));

  const stop = () => {
    clearTimeout(idleTimer);
    server.close();
    for (const s of open) s.destroy();
    try {
      // Only our own state: a newer tunnel for this port may have replaced it.
      const s: unknown = JSON.parse(readFileSync(o.stateFile, "utf8"));
      if (s && typeof s === "object" && "pid" in s && s.pid === process.pid) unlinkSync(o.stateFile);
    } catch {}
    finish();
  };
  const armIdle = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      o.log(`no connection for ${o.idleMs} ms: exiting`);
      stop();
    }, o.idleMs);
  };

  const server = createServer((sock) => {
    open.add(sock);
    clearTimeout(idleTimer);
    const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
    let err = "";
    child.stderr.on("data", (d) => (err = (err + d).slice(-2000)));
    child.stdin.on("error", () => {});
    sock.pipe(child.stdin);
    child.stdout.pipe(sock);
    let killed = false; // ended from this side (the client went): its exit status says nothing
    const end = () => {
      sock.destroy();
      if (child.exitCode === null && child.signalCode === null) {
        killed = true;
        child.kill();
      }
    };
    sock.on("error", end);
    sock.on("close", () => {
      end();
      open.delete(sock);
      if (!open.size) armIdle();
    });
    child.on("error", (e) => {
      o.log(`${cmd}: ${e.message}`);
      end();
    });
    child.on("close", (code) => {
      if (code && !killed) o.log(`${cmd} exited ${code}${err.trim() ? `: ${err.trim()}` : ""}`);
      end();
    });
  });

  // SIGHUP: its terminal went (hc kill, the core stopping).
  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.once(sig, stop);
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = addr && typeof addr === "object" ? addr.port : 0;
      const state: TunnelState = { pid: process.pid, port, remotePort: o.remotePort };
      atomicWrite(o.stateFile, JSON.stringify(state) + "\n");
      o.log(`listening on 127.0.0.1:${port} for the host's port ${o.remotePort}: ${o.argv.join(" ")}`);
      armIdle();
      resolve({ port, done });
    });
  });
}
