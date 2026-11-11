// Synchronous client for svm-worker.mjs (a child process running LiteSVM with
// the real RISE program). Synchronous because RiseVenue quotes are synchronous:
// requests/responses go over two named pipes with blocking fs.writeSync/readSync.
// If the child dies (litesvm can abort with std::bad_alloc), the pending call
// returns null and the next call respawns it and replays program + state.
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const WORKER = path.join(path.dirname(fileURLToPath(import.meta.url)), "svm-worker.mjs");

export interface SnapshotAccount {
  lamports: number;
  owner: string;
  /** base64 */
  data: string;
  executable: boolean;
}

export interface OracleState {
  slot: number;
  rent: { lpby: string; thr: number; burn: number } | null;
  accounts: Record<string, SnapshotAccount | null>;
}

export class SvmOracle {
  private child: ChildProcess | null = null;
  private reqFd = -1;
  private respFd = -1;
  private dir = "";
  private pending = "";
  private program: Buffer | null = null;
  private state: OracleState | null = null;
  /** Number of times the child had to be (re)started. */
  spawns = 0;
  crashes = 0;

  setProgram(elf: Buffer): void {
    this.program = elf;
    if (this.child) this.send({ op: "program", data: elf.toString("base64") });
    if (this.child && this.state) this.send({ op: "state", ...this.state });
  }

  setState(s: OracleState): void {
    this.state = s;
    if (this.child) this.send({ op: "state", ...s });
  }

  get ready(): boolean {
    return this.program !== null && this.state !== null;
  }

  /** Exact program output for Buy(lamports) / Sell(rise), or null if the program rejects it. */
  quote(kind: "buy" | "sell", amount: bigint): { out: bigint | null; err?: string; cu?: number } {
    if (!this.ready) return { out: null, err: "oracle not ready" };
    let r = null;
    // One retry: if the worker died (litesvm abort), respawn it and ask again.
    for (let attempt = 0; attempt < 2 && !r; attempt++) {
      if (!this.child && !this.start()) continue;
      r = this.send({ op: "quote", kind, amount: amount.toString() });
    }
    if (!r) return { out: null, err: "worker crashed" };
    return { out: r.out === null || r.out === undefined ? null : BigInt(r.out), err: r.err, cu: r.cu };
  }

  /** Start the worker now (spawn + program load take ~0.3-0.5 s) instead of on the first quote. */
  warm(): boolean {
    if (!this.ready) return false;
    return this.child !== null || this.start();
  }

  close(): void {
    this.teardown();
  }

  private start(): boolean {
    this.teardown();
    this.dir = fs.mkdtempSync(path.join(os.tmpdir(), "rise-svm-"));
    const req = path.join(this.dir, "req");
    const resp = path.join(this.dir, "resp");
    execFileSync("mkfifo", [req, resp]);
    const child = spawn(process.execPath, [WORKER, req, resp], { stdio: ["ignore", "ignore", "ignore"] });
    child.on("exit", () => {
      if (this.child === child) this.crashes++;
    });
    child.unref();
    this.child = child;
    this.spawns++;
    // Open order matches the worker (req first, then resp) to avoid a deadlock.
    this.reqFd = fs.openSync(req, "w");
    this.respFd = fs.openSync(resp, "r");
    this.pending = "";
    if (this.program && !this.send({ op: "program", data: this.program.toString("base64") })) return false;
    if (this.state && !this.send({ op: "state", ...this.state })) return false;
    return true;
  }

  private teardown(): void {
    const c = this.child;
    this.child = null;
    for (const fd of [this.reqFd, this.respFd]) if (fd >= 0) try { fs.closeSync(fd); } catch { /* ignore */ }
    this.reqFd = this.respFd = -1;
    if (c && c.exitCode === null) try { c.kill("SIGKILL"); } catch { /* ignore */ }
    if (this.dir) try { fs.rmSync(this.dir, { recursive: true, force: true }); } catch { /* ignore */ }
    this.dir = "";
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private send(msg: object): any | null {
    try {
      const line = Buffer.from(JSON.stringify(msg) + "\n");
      let off = 0;
      while (off < line.length) off += fs.writeSync(this.reqFd, line, off);
      const chunk = Buffer.alloc(1 << 16);
      for (;;) {
        const i = this.pending.indexOf("\n");
        if (i >= 0) {
          const out = this.pending.slice(0, i);
          this.pending = this.pending.slice(i + 1);
          return JSON.parse(out);
        }
        const n = fs.readSync(this.respFd, chunk, 0, chunk.length, null);
        if (n === 0) throw new Error("worker EOF");
        this.pending += chunk.toString("utf8", 0, n);
      }
    } catch {
      this.teardown();
      return null;
    }
  }
}
