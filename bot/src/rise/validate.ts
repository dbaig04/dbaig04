// Live validation: RiseNative exact quotes vs mainnet simulateTransaction.
//   NODE_USE_ENV_PROXY=1 npx tsx src/rise/validate.ts [--save-fixture]
// (NODE_USE_ENV_PROXY is only needed where outbound HTTPS must go through HTTPS_PROXY.)
// Uses the reference wallet as fee payer/user; sells are sized to its RISE balance.
import { Connection, PublicKey, Transaction, ComputeBudgetProgram, type AccountInfo, type TransactionInstruction } from "@solana/web3.js";
import fs from "node:fs";
import zlib from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RiseNative, userWsolAta, userRiseAta } from "./index.js";

const RPC = process.env.RPC_URL ?? "https://api.mainnet-beta.solana.com";
const USER = new PublicKey("24Q5e2FRebiFs3iWvN6pZYA4UTGzA3WUsci4ChhgfYEU");
const FIXDIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../fixtures/rise");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function retry<T>(f: () => Promise<T>): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await f();
    } catch (e) {
      if (i >= 6) throw e;
      await sleep(Math.min(1000 * 2 ** i, 15000));
    }
  }
}

const tokAmt = (d: Buffer) => d.readBigUInt64LE(64);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function simulate(conn: Connection, ixs: TransactionInstruction[], addrs: PublicKey[]): Promise<any> {
  const tx = new Transaction();
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }));
  for (const i of ixs) tx.add(i);
  tx.feePayer = USER;
  tx.recentBlockhash = "11111111111111111111111111111111";
  const wire = Buffer.concat([Buffer.from([1]), Buffer.alloc(64), tx.serializeMessage()]).toString("base64");
  await sleep(500);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const res: any = await retry(() => (conn as any)._rpcRequest("simulateTransaction", [wire, {
    encoding: "base64", sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed",
    accounts: { encoding: "base64", addresses: addrs.map((a) => a.toBase58()) },
  }]));
  if (!res.result) throw new Error("simulate: " + JSON.stringify(res.error));
  return res.result;
}

async function main() {
  const save = process.argv.includes("--save-fixture");
  const conn = new Connection(RPC, "confirmed");
  const venue = new RiseNative({ connection: conn });
  const keys = [...venue.accounts(), venue.acc.programData]; // full binary once, for the snapshot
  const uw = userWsolAta(USER), ur = userRiseAta(USER);

  for (let attempt = 0; attempt < 4; attempt++) {
    const snap = await retry(() => conn.getMultipleAccountsInfoAndContext([...keys, uw, ur], "confirmed"));
    const infos = new Map<string, AccountInfo<Buffer> | null>();
    keys.forEach((k, i) => infos.set(k.toBase58(), snap.value[i]));
    venue.update(snap.context.slot, infos);
    const w0 = tokAmt(snap.value[keys.length]!.data), r0 = tokAmt(snap.value[keys.length + 1]!.data);
    const marketData = snap.value[0]!.data;
    console.log(`snapshot slot ${snap.context.slot}  program deployed @${venue.programDeploySlot}  user wSOL ${w0} RISE ${r0}  supply ${venue.market!.supply}`);

    const buys = [1_000_000n, 100_000_000n, 1_000_000_000n, 10_000_000_000n, 50_000_000_000n];
    const sells = [1_000_000_000n, 100_000_000_000n, r0 / 100n, r0 / 10n, r0 / 2n, r0].filter((x) => x > 0n && x <= r0);
    if (w0 > 150_000_000_000n) buys.push(150_000_000_000n);
    const rows: { kind: string; amount: bigint; quote: bigint | null; sim: bigint | null; simSlot: number; err: string | null }[] = [];
    for (const [kind, amount] of [...buys.map((a) => ["buy", a] as const), ...sells.map((a) => ["sell", a] as const)]) {
      const quote = kind === "buy" ? venue.quoteBuy(amount) : venue.quoteSell(amount);
      const res = await simulate(conn, [kind === "buy" ? venue.buyIx(USER, amount, 0n) : venue.sellIx(USER, amount, 0n)], [uw, ur]);
      const v = res.value;
      let sim: bigint | null = null;
      if (!v.err) {
        const pw = tokAmt(Buffer.from(v.accounts[0].data[0], "base64")), pr = tokAmt(Buffer.from(v.accounts[1].data[0], "base64"));
        sim = kind === "buy" ? pr - r0 : pw - w0;
      }
      rows.push({ kind, amount, quote, sim, simSlot: res.context.slot, err: v.err ? JSON.stringify(v.err) : null });
    }
    // Large sells: the reference wallet holds little RISE, so simulate [Buy L, Sell T] in one tx
    // (T = RISE the buy mints). Local side: load the post-Buy state returned by a Buy-only
    // simulation into a second venue and quoteSell(T).
    const stateKeys = keys.slice(0, 7);
    for (const L of [10_000_000_000n, 50_000_000_000n, 150_000_000_000n].filter((l) => l <= w0)) {
      const T = venue.quoteBuy(L)!;
      const s1 = await simulate(conn, [venue.buyIx(USER, L, 0n)], stateKeys);
      const s2 = await simulate(conn, [venue.buyIx(USER, L, 0n), venue.sellIx(USER, T, 0n)], [uw, ur]);
      const post = new Map<string, AccountInfo<Buffer> | null>(infos);
      stateKeys.forEach((k, i) => {
        const a = s1.value.accounts[i];
        post.set(k.toBase58(), a ? { lamports: a.lamports, owner: new PublicKey(a.owner), executable: a.executable, rentEpoch: 0, data: Buffer.from(a.data[0], "base64") } : null);
      });
      const v2 = new RiseNative();
      v2.update(snap.context.slot, post);
      const quote = v2.quoteSell(T);
      v2.close();
      let sim: bigint | null = null;
      if (!s2.value.err) sim = tokAmt(Buffer.from(s2.value.accounts[0].data[0], "base64")) - w0 + L;
      rows.push({ kind: "sell*", amount: T, quote, sim, simSlot: s2.context.slot, err: s2.value.err ? JSON.stringify(s2.value.err) : null });
    }
    // Ensure the market did not change while we were simulating.
    const after = await retry(() => conn.getAccountInfo(keys[0], "confirmed"));
    if (!after || !after.data.equals(marketData)) {
      console.log("market changed during validation (a trade landed); retrying");
      continue;
    }
    console.log("\n(sell* = sell of the RISE minted by a Buy of the same tx, quoted on the post-Buy state)");
    console.log("\n| dir  | amount in | quote (exact) | mainnet simulate | match | sim slot |");
    console.log("|------|-----------|---------------|------------------|-------|----------|");
    let ok = 0;
    for (const r of rows) {
      const match = r.quote !== null && r.quote === r.sim;
      if (match) ok++;
      console.log(`| ${r.kind.padEnd(4)} | ${r.amount} | ${r.quote ?? "null"} | ${r.sim ?? "ERR " + r.err} | ${match ? "yes" : "NO"} | ${r.simSlot} |`);
    }
    console.log(`\n${ok}/${rows.length} exact matches; market unchanged from slot ${snap.context.slot} through the last simulation`);
    if (save) {
      fs.mkdirSync(FIXDIR, { recursive: true });
      const accounts: Record<string, unknown> = {};
      keys.forEach((k, i) => {
        if (k.equals(venue.acc.programData)) return;
        const a = snap.value[i];
        accounts[k.toBase58()] = a ? { lamports: a.lamports, owner: a.owner.toBase58(), executable: a.executable, data: a.data.toString("base64") } : null;
      });
      const pd = snap.value[keys.findIndex((k) => k.equals(venue.acc.programData))]!;
      fs.writeFileSync(path.join(FIXDIR, "program.so.gz"), zlib.gzipSync(pd.data.subarray(45), { level: 9 }));
      fs.writeFileSync(path.join(FIXDIR, "snapshot.json"), JSON.stringify({
        slot: snap.context.slot, programDeploySlot: venue.programDeploySlot!.toString(), accounts,
        expected: rows.filter((r) => r.sim !== null).map((r) => ({ kind: r.kind, amount: r.amount.toString(), out: r.sim!.toString() })),
      }, null, 1));
      console.log("fixture saved to", FIXDIR);
    }
    venue.close();
    return;
  }
  venue.close();
  throw new Error("market kept changing; could not get a clean validation window");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
