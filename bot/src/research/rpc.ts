// Rate-limited raw JSON-RPC client for research scripts (public RPC: keep well under
// its limits; back off on 429 / -32429). Every getTransaction / getBlock call passes
// maxSupportedTransactionVersion: 1 (recent mainnet txs are often v1).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { keepAliveFetch } from "../feeds/http.js";

export interface RpcOptions {
  url?: string;
  /** Max requests per second for this process (default RESEARCH_RPS or 2). */
  rps?: number;
  log?: (m: string) => void;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class RateLimitedRpc {
  readonly url: string;
  private readonly gapMs: number;
  private next = 0;
  private fetch = keepAliveFetch({ connections: 2 });
  requests = 0;
  throttled = 0;
  private log: (m: string) => void;

  constructor(o: RpcOptions = {}) {
    this.url = o.url ?? process.env.RPC_URL ?? "https://api.mainnet-beta.solana.com";
    const rps = o.rps ?? Number(process.env.RESEARCH_RPS ?? 2);
    this.gapMs = 1000 / Math.max(0.05, rps);
    this.log = o.log ?? (() => {});
  }

  /** Wait for this process's next request slot. */
  private async slot(): Promise<void> {
    const now = Date.now();
    const at = Math.max(now, this.next);
    this.next = at + this.gapMs;
    if (at > now) await sleep(at - now);
  }

  async call<T>(method: string, params: unknown[], attempts = 8): Promise<T> {
    let backoff = 1000;
    for (let i = 0; ; i++) {
      await this.slot();
      this.requests++;
      let status = 0;
      let body: { result?: T; error?: { code: number; message: string } } | undefined;
      try {
        const r = await this.fetch(this.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
        status = r.status;
        if (r.status === 429) throw Object.assign(new Error("429"), { retry: true });
        body = (await r.json()) as typeof body;
      } catch (e) {
        if (i + 1 >= attempts) throw e;
        if ((e as { retry?: boolean }).retry) this.throttled++;
        this.log(`rpc ${method}: ${(e as Error).message} (status ${status}); backing off ${backoff} ms`);
        await sleep(backoff);
        backoff = Math.min(backoff * 2, 30_000);
        this.next = Date.now() + this.gapMs;
        continue;
      }
      if (body?.error) {
        const retry = body.error.code === -32429 || /rate|too many|timeout|unavailable|temporar/i.test(body.error.message);
        if (!retry || i + 1 >= attempts) throw new Error(`${method}: ${body.error.code} ${body.error.message}`);
        this.throttled++;
        await sleep(backoff);
        backoff = Math.min(backoff * 2, 30_000);
        continue;
      }
      return body!.result as T;
    }
  }
}

export interface SigInfo { signature: string; slot: number; err: unknown; blockTime: number | null; memo: string | null }

/** getSignaturesForAddress, paging backwards until `max` sigs or `untilBlockTime`. Newest first. */
export async function signaturesFor(rpc: RateLimitedRpc, address: string, o: { max?: number; untilBlockTime?: number; until?: string; before?: string } = {}): Promise<SigInfo[]> {
  const out: SigInfo[] = [];
  let before = o.before;
  const max = o.max ?? 1000;
  while (out.length < max) {
    const page = await rpc.call<SigInfo[]>("getSignaturesForAddress", [address, { limit: Math.min(1000, max - out.length), ...(before ? { before } : {}), ...(o.until ? { until: o.until } : {}), commitment: "confirmed" }]);
    if (!page.length) break;
    for (const s of page) {
      if (o.untilBlockTime !== undefined && s.blockTime !== null && s.blockTime < o.untilBlockTime) return out;
      out.push(s);
    }
    before = page[page.length - 1].signature;
    if (page.length < 1000 && out.length < max) break;
  }
  return out;
}

/** getTransaction (json, v1) with an on-disk cache directory. */
export async function getTxCached(rpc: RateLimitedRpc, sig: string, dir: string): Promise<unknown | null> {
  mkdirSync(dir, { recursive: true });
  const f = join(dir, `${sig}.json`);
  if (existsSync(f)) return JSON.parse(readFileSync(f, "utf8"));
  const r = await rpc.call<unknown | null>("getTransaction", [sig, { encoding: "json", maxSupportedTransactionVersion: 1, commitment: "confirmed" }]);
  if (r) writeFileSync(f, JSON.stringify(r));
  return r;
}
