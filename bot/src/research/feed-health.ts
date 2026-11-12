// Feed health and freshness for VPS runs: ERPC Geyser gRPC (processed/confirmed), UDP shreds,
// and which RPC is used for reads / simulation / competitor collection. Never prints credentials:
// only the RPC host name and whether it is the public mainnet endpoint.
import type { Connection } from "@solana/web3.js";
import type { Config } from "../config.js";
import type { GrpcProvider } from "../feeds/grpc.js";
import type { ShredsUdpFeed } from "../feeds/shreds-udp.js";

export const PUBLIC_RPC_HOSTS = new Set(["api.mainnet-beta.solana.com", "solana-api.projectserum.com"]);

export interface RpcInfo {
  host: string;
  isPublic: boolean;
  /** "RPC_URL" set explicitly in the environment, or the built-in default. */
  source: "env" | "default";
}

export function rpcInfo(cfg: Pick<Config, "rpcUrl">, env: NodeJS.ProcessEnv = process.env): RpcInfo {
  let host = "(invalid url)";
  try { host = new URL(cfg.rpcUrl).hostname; } catch { /* keep placeholder */ }
  return { host, isPublic: PUBLIC_RPC_HOSTS.has(host), source: env.RPC_URL ? "env" : "default" };
}

export function describeRpc(r: RpcInfo): string {
  return r.isPublic
    ? `PUBLIC RPC fallback in use (${r.host}${r.source === "default" ? ", RPC_URL not set" : ""})`
    : `private RPC host ${r.host} (from ${r.source === "env" ? "RPC_URL" : "default"}; path/query not shown)`;
}

const q = (xs: number[], p: number) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))];
};
const f = (x: number, d = 1) => (Number.isFinite(x) ? x.toFixed(d) : "-");

export interface FeedHealth {
  rpc: RpcInfo & { getSlotMs: number[]; ok: boolean; error?: string };
  grpc?: {
    commitment: string; status: string; healthy: boolean; reconnects: number;
    slotMsgs: number; accountMsgs: number; accountsSubscribed: number; perAccount: Record<string, number>;
  };
  shreds?: { packets: number; accepted: number; invalid: number; foreign: number; batches: number; recoveredBatches: number; txs: number; matches: number };
}

/** RPC reachability/latency (5 getSlot calls) — host only, never the URL. */
export async function probeRpc(conn: Connection, cfg: Pick<Config, "rpcUrl">): Promise<FeedHealth["rpc"]> {
  const info = rpcInfo(cfg);
  const ms: number[] = [];
  try {
    for (let i = 0; i < 5; i++) {
      const t = performance.now();
      await conn.getSlot("processed");
      ms.push(performance.now() - t);
    }
    return { ...info, getSlotMs: ms, ok: true };
  } catch (e) {
    // the error text can contain the URL: keep only its first words, no "http"
    const msg = String((e as Error).message ?? e).replace(/https?:\/\/\S+/g, "<url>").slice(0, 120);
    return { ...info, getSlotMs: ms, ok: false, error: msg };
  }
}

export function feedHealth(rpc: FeedHealth["rpc"], grpc?: GrpcProvider, shreds?: ShredsUdpFeed): FeedHealth {
  const out: FeedHealth = { rpc };
  if (grpc) {
    const st = grpc.info();
    out.grpc = {
      commitment: grpc.commitment, status: st.status, healthy: st.healthy, reconnects: st.reconnects,
      slotMsgs: grpc.freshness.slotMsgs, accountMsgs: grpc.freshness.accountMsgs, accountsSubscribed: st.accounts,
      perAccount: Object.fromEntries(grpc.freshness.perAccount),
    };
  }
  if (shreds) {
    const s = shreds.stats as unknown as Record<string, number>;
    out.shreds = {
      packets: s.packets ?? 0, accepted: s.accepted ?? 0, invalid: s.invalid ?? 0, foreign: s.foreign ?? 0,
      batches: s.completedBatches ?? 0, recoveredBatches: s.recoveredBatches ?? 0, txs: s.txs ?? 0, matches: s.matches ?? 0,
    };
  }
  return out;
}

export function preflightLines(h: FeedHealth, seconds: number): string[] {
  const L: string[] = [];
  L.push(`RPC: ${describeRpc(h.rpc)}; ${h.rpc.ok ? `getSlot ${h.rpc.getSlotMs.map((x) => x.toFixed(0)).join("/")} ms` : `ERROR ${h.rpc.error}`}`);
  if (!h.grpc) L.push("gRPC: NOT CONFIGURED (GRPC_ENDPOINT unset) - state comes from RPC polling");
  else {
    const g = h.grpc;
    const ok = g.healthy && g.accountMsgs > 0;
    L.push(`gRPC (${g.commitment}): ${ok ? "OK" : "PROBLEM"} status=${g.status} healthy=${g.healthy} reconnects=${g.reconnects} in ${seconds}s: ${g.slotMsgs} slot msgs, ${g.accountMsgs} account updates over ${g.accountsSubscribed} subscribed accounts`);
  }
  if (!h.shreds) L.push("UDP shreds: NOT CONFIGURED (SHREDS_UDP_PORT unset)");
  else {
    const s = h.shreds;
    const ok = s.accepted > 0 && s.txs > 0;
    L.push(`UDP shreds: ${ok ? "OK" : "PROBLEM"} in ${seconds}s: ${s.packets} packets (${f(s.packets / seconds, 0)}/s), ${s.accepted} accepted, ${s.invalid} invalid, ${s.foreign} foreign-source, ${s.batches} batches decoded (${s.recoveredBatches} via erasure recovery), ${s.txs} txs, ${s.matches} RISE/MAX matches`);
  }
  return L;
}

/**
 * Freshness of Geyser account updates:
 *  - slots behind the stream tip at receipt,
 *  - ms between the slot's first announcement on the stream and the account update,
 *  - shred lead: ms between the first UDP shred of that slot and the gRPC account update
 *    (positive = shreds saw the slot earlier).
 */
export function freshnessLines(grpc?: GrpcProvider, shreds?: ShredsUdpFeed): string[] {
  if (!grpc) return ["gRPC not configured: no freshness data."];
  const s = grpc.freshness.samples;
  const lag = s.map((x) => x[2]);
  const sinceAnn = s.filter((x) => x[3] >= 0).map((x) => x[3]);
  const lead: number[] = [];
  if (shreds) for (const [at, slot] of s) { const t0 = shreds.slotFirstShredAt.get(slot); if (t0 !== undefined) lead.push(at - t0); }
  const row = (name: string, xs: number[], unit: string) => `| ${name} | ${xs.length} | ${f(q(xs, 0.5))} | ${f(q(xs, 0.95))} | ${f(xs.length ? Math.max(...xs) : NaN)} | ${unit} |`;
  return [
    `Geyser commitment: **${grpc.commitment}**; ${grpc.freshness.accountMsgs} account updates, ${grpc.freshness.slotMsgs} slot messages.`,
    "",
    "| metric | n | median | p95 | max | unit |",
    "|---|---|---|---|---|---|",
    row("account update: slots behind stream tip", lag, "slots"),
    row("account update: time since its slot was first announced", sinceAnn, "ms"),
    row("shred lead: first UDP shred of the slot -> gRPC account update", lead, "ms"),
  ];
}
