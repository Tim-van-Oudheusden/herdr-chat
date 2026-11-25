// omp's RPC protocol v2 transport: after `negotiate_protocol`, a stdout object
// larger than one physical frame (1 MiB) arrives as an uninterrupted run of
// `rpc_chunk` frames, each a base64 slice of the object's UTF-8 JSON (omp
// docs/rpc.md "Transport and Framing"). A port of omp's RpcFrameDecoder: herdr-chat
// runs on Node without omp installed, so it can't import it.

/** The reassembly limit omp advertises in its `ready` frame (`maxReassembledFrameBytes`). */
export const MAX_REASSEMBLED_BYTES = 64 * 1024 * 1024;

export type ChunkFrame = { type: "rpc_chunk"; chunkId: string; index: number; count: number; byteLength: number; data: string };

export function isChunk(rec: Record<string, unknown>): rec is ChunkFrame & Record<string, unknown> {
  return rec.type === "rpc_chunk";
}

/**
 * Reassembles `rpc_chunk` runs. `push` takes one chunk frame and returns the
 * whole object's JSON text once its last chunk arrived, else null. A malformed,
 * interleaved or interrupted run throws (the decoder drops it and starts over).
 */
export class ChunkDecoder {
  private id: string | null = null;
  private count = 0;
  private byteLength = 0;
  private parts: Buffer[] = [];
  private size = 0;
  private max: number;

  constructor(max = MAX_REASSEMBLED_BYTES) {
    this.max = max;
  }

  /** A run is in progress: any frame but its next chunk interrupts it. */
  get pending(): boolean {
    return this.id !== null;
  }

  /** Drops a run in progress (a non-chunk frame arrived in the middle of it); returns its chunk id. */
  interrupt(): string | null {
    const id = this.id;
    this.reset();
    return id;
  }

  push(f: ChunkFrame): string | null {
    const { chunkId, index, count, byteLength, data } = f;
    if (typeof chunkId !== "string" || !chunkId) return this.fail("rpc_chunk without a chunkId");
    if (!Number.isInteger(count) || count < 1) return this.fail(`rpc_chunk ${chunkId}: bad count ${count}`);
    if (!Number.isInteger(byteLength) || byteLength < 0 || byteLength > this.max) return this.fail(`rpc_chunk ${chunkId}: byteLength ${byteLength} over the ${this.max}-byte limit`);
    if (typeof data !== "string") return this.fail(`rpc_chunk ${chunkId}: no data`);
    if (this.id === null) {
      if (index !== 0) return this.fail(`rpc_chunk ${chunkId}: run starts at index ${index}`);
      this.id = chunkId;
      this.count = count;
      this.byteLength = byteLength;
    } else if (chunkId !== this.id) {
      return this.fail(`rpc_chunk ${chunkId} interleaved with ${this.id}`);
    } else if (count !== this.count || byteLength !== this.byteLength || index !== this.parts.length) {
      return this.fail(`rpc_chunk ${chunkId}: chunk ${index}/${count} out of order`);
    }
    const bytes = Buffer.from(data, "base64");
    this.size += bytes.length;
    if (this.size > this.byteLength) return this.fail(`rpc_chunk ${chunkId}: more bytes than its byteLength ${this.byteLength}`);
    this.parts.push(bytes);
    if (this.parts.length < this.count) return null;
    const all = Buffer.concat(this.parts);
    const expected = this.byteLength;
    this.reset();
    if (all.length !== expected) throw new Error(`rpc_chunk ${chunkId}: ${all.length} bytes, expected ${expected}`);
    // Strict UTF-8: a bad sequence throws rather than becoming U+FFFD.
    return new TextDecoder("utf-8", { fatal: true }).decode(all);
  }

  private fail(msg: string): never {
    this.reset();
    throw new Error(msg);
  }

  private reset(): void {
    this.id = null;
    this.count = 0;
    this.byteLength = 0;
    this.parts = [];
    this.size = 0;
  }
}
