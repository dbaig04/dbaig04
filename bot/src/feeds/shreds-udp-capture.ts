// Raw shred UDP capture: record the packets ERPC forwards (with arrival time and source)
// into a compact file that `npx tsx src/feeds/shreds-udp.ts --replay <file>` and the tests
// can replay offline.
//
//   npx tsx src/feeds/shreds-udp-capture.ts --port 20000 --seconds 30 --out /var/tmp/shreds.cap \
//       [--bind 0.0.0.0] [--rcvbuf 67108864] [--allow 1.2.3.4,5.6.7.8] [--max-mb 2048] [--force]
//
// Nothing is recorded unless --out is given; write captures outside the repo (they are not
// gitignored-by-path, only *.shredcap / *.cap names are). Stop the bot first (or use another
// port): two sockets on one port do not both receive the packets.
//
// File format (little-endian):
//   header 24 bytes: "SHREDCAP" | u16 version (1) | u16 flags (0) | u32 reserved | u64 start unix ns
//   record:          u64 arrival unix ns | u8 address length | address (ASCII) | u16 source port
//                    | u16 payload length | payload
import { createSocket, type Socket } from "node:dgram";
import { createWriteStream, existsSync, readFileSync } from "node:fs";
import { isIP } from "node:net";
import { pathToFileURL } from "node:url";

export const CAPTURE_MAGIC = "SHREDCAP";
export const CAPTURE_VERSION = 1;
export const CAPTURE_HEADER_SIZE = 24;

export interface CapturedPacket {
  /** Arrival time, unix epoch nanoseconds. */
  tNs: bigint;
  address: string;
  port: number;
  payload: Uint8Array;
}

export function encodeCaptureHeader(startNs: bigint): Buffer {
  const b = Buffer.alloc(CAPTURE_HEADER_SIZE);
  b.write(CAPTURE_MAGIC, 0, "latin1");
  b.writeUInt16LE(CAPTURE_VERSION, 8);
  b.writeBigUInt64LE(startNs, 16);
  return b;
}

export function encodeCaptureRecord(p: CapturedPacket): Buffer {
  const addr = Buffer.from(p.address, "latin1");
  if (addr.length > 255) throw new Error("capture: address too long");
  if (p.payload.length > 0xffff) throw new Error("capture: payload too long");
  const b = Buffer.alloc(8 + 1 + addr.length + 2 + 2 + p.payload.length);
  let o = b.writeBigUInt64LE(p.tNs, 0);
  o = b.writeUInt8(addr.length, o);
  o += addr.copy(b, o);
  o = b.writeUInt16LE(p.port, o);
  o = b.writeUInt16LE(p.payload.length, o);
  b.set(p.payload, o);
  return b;
}

/** Parse a whole capture file. Throws on a bad header; a truncated last record ends the stream. */
export function* readCapture(buf: Uint8Array): Generator<CapturedPacket> {
  const b = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  if (b.length < CAPTURE_HEADER_SIZE || b.toString("latin1", 0, 8) !== CAPTURE_MAGIC) throw new Error("capture: bad magic");
  const v = b.readUInt16LE(8);
  if (v !== CAPTURE_VERSION) throw new Error(`capture: unsupported version ${v}`);
  let o = CAPTURE_HEADER_SIZE;
  while (o + 9 <= b.length) {
    const tNs = b.readBigUInt64LE(o);
    const al = b[o + 8];
    const at = o + 9;
    if (at + al + 4 > b.length) return;
    const address = b.toString("latin1", at, at + al);
    const port = b.readUInt16LE(at + al);
    const len = b.readUInt16LE(at + al + 2);
    const ps = at + al + 4;
    if (ps + len > b.length) return;
    yield { tNs, address, port, payload: b.subarray(ps, ps + len) };
    o = ps + len;
  }
}

export function captureStartNs(buf: Uint8Array): bigint {
  return Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength).readBigUInt64LE(16);
}

export function readCaptureFile(path: string): CapturedPacket[] {
  return [...readCapture(readFileSync(path))];
}

/** IPv4-mapped IPv6 ("::ffff:1.2.3.4") -> "1.2.3.4". */
export function normalizeAddress(a: string): string {
  const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(a);
  return m ? m[1] : a.toLowerCase();
}

/** Monotonic unix-ns clock (hrtime anchored to the wall clock once). */
export function unixNsClock(): () => bigint {
  const wall = BigInt(Date.now()) * 1_000_000n;
  const hr0 = process.hrtime.bigint();
  return () => wall + (process.hrtime.bigint() - hr0);
}

export interface CaptureOptions {
  port: number;
  seconds: number;
  out: string;
  bind?: string;
  rcvbuf?: number;
  allow?: string[];
  maxBytes?: number;
  force?: boolean;
  log?: (m: string) => void;
}

export interface CaptureResult { packets: number; bytes: number; dropped: number; foreign: number; rcvbuf: number }

/** Record raw packets for `seconds` into `out`. */
export function capture(o: CaptureOptions): Promise<CaptureResult> {
  const log = o.log ?? console.log;
  if (existsSync(o.out) && !o.force) return Promise.reject(new Error(`${o.out} exists (use --force to overwrite)`));
  const bind = o.bind ?? "0.0.0.0";
  const allow = o.allow?.length ? new Set(o.allow.map(normalizeAddress)) : null;
  const clock = unixNsClock();
  const out = createWriteStream(o.out);
  out.write(encodeCaptureHeader(clock()));
  const sock: Socket = createSocket({ type: isIP(bind) === 6 ? "udp6" : "udp4", recvBufferSize: o.rcvbuf ?? 64 * 1024 * 1024 });
  const r: CaptureResult = { packets: 0, bytes: 0, dropped: 0, foreign: 0, rcvbuf: 0 };
  const maxBytes = o.maxBytes ?? 2048 * 1024 * 1024;
  return new Promise((resolve, reject) => {
    sock.on("error", (e) => { sock.close(); out.end(); reject(e); });
    sock.on("message", (msg, rinfo) => {
      const t = clock();
      const address = normalizeAddress(rinfo.address);
      if (allow && !allow.has(address)) { r.foreign++; return; }
      if (r.bytes >= maxBytes) { r.dropped++; return; }
      const rec = encodeCaptureRecord({ tNs: t, address, port: rinfo.port, payload: msg });
      r.packets++;
      r.bytes += rec.length;
      out.write(rec);
    });
    sock.bind(o.port, bind, () => {
      try { r.rcvbuf = sock.getRecvBufferSize(); } catch { /* ignore */ }
      log(`capturing udp ${bind}:${o.port} for ${o.seconds}s -> ${o.out} (rcvbuf ${r.rcvbuf} bytes${allow ? `, ${allow.size} allowed sources` : ", all sources"})`);
      // the bound socket keeps the process alive until the timer closes it
      setTimeout(() => {
        sock.close();
        out.end(() => resolve(r));
      }, o.seconds * 1000);
    });
  });
}

function arg(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

async function main(argv: string[]) {
  const port = Number(arg(argv, "--port"));
  const seconds = Number(arg(argv, "--seconds"));
  const out = arg(argv, "--out");
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !(seconds > 0) || !out) {
    console.error("usage: npx tsx src/feeds/shreds-udp-capture.ts --port P --seconds S --out FILE [--bind ADDR] [--rcvbuf BYTES] [--allow ip,ip] [--max-mb N] [--force]");
    process.exit(2);
  }
  const r = await capture({
    port, seconds, out, bind: arg(argv, "--bind"), rcvbuf: arg(argv, "--rcvbuf") ? Number(arg(argv, "--rcvbuf")) : undefined,
    allow: arg(argv, "--allow")?.split(",").map((s) => s.trim()).filter(Boolean),
    maxBytes: arg(argv, "--max-mb") ? Number(arg(argv, "--max-mb")) * 1024 * 1024 : undefined, force: argv.includes("--force"),
  });
  console.log(`captured ${r.packets} packets (${r.bytes} bytes) to ${out}; foreign-source drops ${r.foreign}, size-cap drops ${r.dropped}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((e) => { console.error((e as Error).message); process.exit(1); });
}
