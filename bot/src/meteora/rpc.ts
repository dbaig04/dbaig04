// Minimal throttled JSON-RPC client used by validate.ts / fixture capture only (the venue itself
// does no I/O). Keeps public mainnet RPC under ~3 req/s and backs off on 429.
// NOTE: behind an HTTPS proxy run with NODE_USE_ENV_PROXY=1 (Node >= 22.21).
import { AccountInfo, PublicKey } from "@solana/web3.js";

export const DEFAULT_RPC = process.env.RPC_URL ?? "https://api.mainnet-beta.solana.com";

let last = 0;
const MIN_GAP_MS = 400;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function rpc<T = any>(method: string, params: unknown[], url = DEFAULT_RPC): Promise<T> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const wait = last + MIN_GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);
    last = Date.now();
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
    } catch (e) {
      await sleep(1000 * 2 ** attempt);
      continue;
    }
    if (res.status === 429 || res.status >= 500) {
      await sleep(1000 * 2 ** attempt);
      continue;
    }
    const j: any = await res.json();
    if (j.error) {
      if (j.error.code === 429 || j.error.code === -32429) {
        await sleep(1000 * 2 ** attempt);
        continue;
      }
      throw new Error(`${method}: ${JSON.stringify(j.error)}`);
    }
    return j.result as T;
  }
  throw new Error(`${method}: too many retries`);
}

export interface Snapshot {
  slot: number;
  infos: Map<string, AccountInfo<Buffer> | null>;
}

export async function getMultipleAccounts(keys: PublicKey[], url = DEFAULT_RPC): Promise<Snapshot> {
  const infos = new Map<string, AccountInfo<Buffer> | null>();
  let slot = 0;
  for (let i = 0; i < keys.length; i += 100) {
    const chunk = keys.slice(i, i + 100);
    const r: any = await rpc("getMultipleAccounts", [chunk.map((k) => k.toBase58()), { encoding: "base64", commitment: "confirmed" }], url);
    slot = Math.max(slot, r.context.slot);
    r.value.forEach((v: any, j: number) => {
      infos.set(
        chunk[j].toBase58(),
        v
          ? { data: Buffer.from(v.data[0], "base64"), owner: new PublicKey(v.owner), lamports: v.lamports, executable: v.executable, rentEpoch: v.rentEpoch }
          : null,
      );
    });
  }
  return { slot, infos };
}

// ---- simulation helpers (validate scripts only) ----
import { TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";

export interface SimResult {
  slot: number;
  err: unknown;
  logs: string[];
  unitsConsumed?: number;
  /** post-state of the requested addresses (null if the account does not exist after the sim) */
  accounts: (Buffer | null)[];
  innerInstructions?: any[];
}

/** simulateTransaction (sigVerify:false, replaceRecentBlockhash:true) of a v0 tx paid by `payer`. */
export async function simulateIxs(payer: PublicKey, ixs: TransactionInstruction[], addresses: PublicKey[], url = DEFAULT_RPC): Promise<SimResult> {
  const msg = new TransactionMessage({ payerKey: payer, recentBlockhash: PublicKey.default.toBase58(), instructions: ixs }).compileToV0Message();
  const tx = new VersionedTransaction(msg);
  const r: any = await rpc(
    "simulateTransaction",
    [
      Buffer.from(tx.serialize()).toString("base64"),
      {
        encoding: "base64",
        sigVerify: false,
        replaceRecentBlockhash: true,
        commitment: "confirmed",
        innerInstructions: true,
        accounts: { encoding: "base64", addresses: addresses.map((k) => k.toBase58()) },
      },
    ],
    url,
  );
  const v = r.value;
  return {
    slot: r.context.slot,
    err: v.err,
    logs: v.logs ?? [],
    unitsConsumed: v.unitsConsumed,
    accounts: (v.accounts ?? []).map((a: any) => (a ? Buffer.from(a.data[0], "base64") : null)),
    innerInstructions: v.innerInstructions,
  };
}

/** Snapshot venue accounts (+extra) with a second pass when the venue's account set grew. */
export async function snapshotFor(src: { accounts(): PublicKey[]; update(slot: number, infos: Map<string, AccountInfo<Buffer> | null>): void }[], extra: PublicKey[], url = DEFAULT_RPC): Promise<Snapshot> {
  const keysOf = () => [...new Map([...src.flatMap((s) => s.accounts()), ...extra].map((k) => [k.toBase58(), k])).values()];
  let keys = keysOf();
  let s = await getMultipleAccounts(keys, url);
  for (let pass = 0; pass < 3; pass++) {
    for (const v of src) v.update(s.slot, s.infos);
    const want = keysOf();
    if (!want.some((k) => !s.infos.has(k.toBase58()))) break;
    s = await getMultipleAccounts(want, url);
  }
  return s;
}
