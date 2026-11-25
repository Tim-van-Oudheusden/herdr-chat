// The omp child process: Pi's transport (PiProcess: process group, LF framing,
// request correlation, teardown) plus protocol v2's chunked frames (frame.ts).
// A reassembled object over the record cap is dropped like an oversized line,
// its head kept, so a run stays consistent the same way Pi's does.
import { PiProcess } from "../pi/rpc.ts";
import type { SpawnOptions } from "../pi/rpc.ts";
import { MAX_RECORD_BYTES } from "../../framing.ts";
import { ChunkDecoder, isChunk } from "./frame.ts";

const CHUNK_PREFIX = '{"type":"rpc_chunk"';

export class OmpProcess extends PiProcess {
  private chunks = new ChunkDecoder();
  /** A chunked frame could not be decoded (logged by the adapter). */
  onFrameError: (msg: string) => void = () => {};

  constructor(opts: SpawnOptions) {
    super({ ...opts, label: opts.label ?? "omp" });
  }

  protected override route(line: string): void {
    if (!line.startsWith(CHUNK_PREFIX)) {
      const dropped = this.chunks.interrupt();
      if (dropped) this.onFrameError(`rpc_chunk ${dropped} was interrupted by another frame`);
      super.route(line);
      return;
    }
    let whole: string | null;
    try {
      const rec = JSON.parse(line);
      if (!isChunk(rec)) return super.route(line);
      whole = this.chunks.push(rec);
    } catch (e) {
      this.onFrameError(e instanceof Error ? e.message : String(e));
      return;
    }
    if (whole === null) return;
    const size = Buffer.byteLength(whole);
    if (size > MAX_RECORD_BYTES) this.oversized({ size, head: whole.slice(0, 4096) });
    else super.route(whole);
  }
}
