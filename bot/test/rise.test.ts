// RISE venue tests (offline). Fixtures in fixtures/rise/:
//  - history.json: fee fields decoded from 93 historical Buy/Sell events of the
//    reference wallet + the account metas of a real Buy (tx 21Z1Fd...) and Sell.
//  - snapshot.json + program.so.gz: account snapshot and program binary at one
//    slot, plus mainnet simulateTransaction results for that exact state
//    (written by `src/rise/validate.ts --save-fixture`).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import zlib from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PublicKey, type AccountInfo } from "@solana/web3.js";
import { RiseNative, deriveAccounts, decodeMarket, feeSplit, userAtas, BUY_DISCRIMINATOR, SELL_DISCRIMINATOR } from "../src/rise/index.js";

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), "../fixtures/rise");
const history = JSON.parse(fs.readFileSync(path.join(FIX, "history.json"), "utf8"));
const snap = JSON.parse(fs.readFileSync(path.join(FIX, "snapshot.json"), "utf8"));

function snapshotInfos(venue: RiseNative): Map<string, AccountInfo<Buffer> | null> {
  const m = new Map<string, AccountInfo<Buffer> | null>();
  for (const [k, a] of Object.entries<{ lamports: number; owner: string; executable: boolean; data: string } | null>(snap.accounts)) {
    m.set(k, a ? { lamports: a.lamports, owner: new PublicKey(a.owner), executable: a.executable, rentEpoch: 0, data: Buffer.from(a.data, "base64") } : null);
  }
  const elf = zlib.gunzipSync(fs.readFileSync(path.join(FIX, "program.so.gz")));
  const hdr = Buffer.alloc(45);
  hdr.writeUInt32LE(3, 0);
  hdr.writeBigUInt64LE(BigInt(snap.programDeploySlot), 4);
  m.set(venue.acc.programData.toBase58(), {
    lamports: 0, owner: new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111"), executable: false, rentEpoch: 0, data: Buffer.concat([hdr, elf]),
  });
  return m;
}

test("PDAs match the accounts used on chain and the bumps stored in the market", () => {
  const a = deriveAccounts();
  const metas = history.buyTx.metas.map((m: { pubkey: string }) => m.pubkey);
  assert.equal(a.market.toBase58(), metas[1]);
  assert.equal(a.vault.toBase58(), metas[2]);
  assert.equal(a.creatorClaim.toBase58(), metas[3]);
  assert.equal(a.teamVault.toBase58(), metas[4]);
  assert.equal(a.reflectionVault.toBase58(), metas[5]);
  assert.equal(a.eventAuthority.toBase58(), metas[14]);
  assert.equal(a.programData.toBase58(), "2jmivXMvRcbxdsRLqBTwSLWuDgpbAoV9rFbtj5wsXB1E");
  const mk = decodeMarket(Buffer.from(snap.accounts[a.market.toBase58()].data, "base64"));
  const bump = (seeds: Buffer[]) => PublicKey.findProgramAddressSync(seeds, new PublicKey(metas[15]))[1];
  assert.equal(mk.marketBump, bump([Buffer.from("market"), new PublicKey(metas[6]).toBuffer()]));
  assert.equal(mk.vaultBump, bump([Buffer.from("vault"), a.market.toBuffer()]));
  assert.equal(mk.creatorClaimBump, bump([Buffer.from("creator_claim"), a.market.toBuffer()]));
});

test("user ATA helpers match the reference wallet's accounts", () => {
  const { wsolAta, riseAta } = userAtas(new PublicKey(history.buyTx.user));
  assert.equal(wsolAta.toBase58(), history.buyTx.metas[8].pubkey);
  assert.equal(riseAta.toBase58(), history.buyTx.metas[9].pubkey);
});

test("buyIx / sellIx reproduce the historical instruction exactly", () => {
  const v = new RiseNative();
  const user = new PublicKey(history.buyTx.user);
  const ix = v.buyIx(user, 523_999_059n, 858_078_326_245n); // args of tx 21Z1Fd...
  assert.deepEqual(ix.keys.map((k) => ({ pubkey: k.pubkey.toBase58(), isSigner: k.isSigner, isWritable: k.isWritable })), history.buyTx.metas);
  assert.equal(ix.data.toString("hex"), "66063d1201daebea53973b1f00000000e52d74c9c7000000");
  const s = v.sellIx(user, 1n, 2n);
  assert.deepEqual(s.keys.map((k) => k.pubkey.toBase58()), history.sellAccounts);
  assert.ok(s.data.subarray(0, 8).equals(SELL_DISCRIMINATOR) && ix.data.subarray(0, 8).equals(BUY_DISCRIMINATOR));
  v.close();
});

test("fee schedule matches all historical trades (fee = ceil 1.25%, two floor halves)", () => {
  assert.ok(history.fees.length >= 90);
  for (const f of history.fees) {
    const { fee, half, charged } = feeSplit(BigInt(f.amount), 12_500);
    assert.equal(fee.toString(), f.feeTotal, f.sig);
    assert.equal(half.toString(), f.creator, f.sig);
    assert.equal(half.toString(), f.team, f.sig);
    // Buy: the vault is credited lamports_in - 2*half (the odd lamport stays there);
    // the curve prices lamports_in - fee. Sell: the user gets gross - fee.
    if (f.kind === "buy") assert.equal((BigInt(f.amount) - charged).toString(), f.vaultIn, f.sig);
    else assert.equal((BigInt(f.amount) - fee).toString(), f.userOut, f.sig);
  }
  const mk = decodeMarket(Buffer.from(snap.accounts[deriveAccounts().market.toBase58()].data, "base64"));
  assert.equal(mk.buyFeePpm, 12_500);
  assert.equal(mk.sellFeePpm, 12_500);
  assert.equal(mk.creatorShareBps + mk.teamShareBps, 10_000);
});

test("LiteSVM quotes equal mainnet simulateTransaction results for the saved snapshot", () => {
  const v = new RiseNative();
  v.update(snap.slot, snapshotInfos(v));
  const rows = snap.expected.filter((e: { kind: string }) => e.kind === "buy" || e.kind === "sell");
  assert.ok(rows.length >= 8);
  for (const e of rows) {
    const q = e.kind === "buy" ? v.quoteBuy(BigInt(e.amount)) : v.quoteSell(BigInt(e.amount));
    assert.equal(q?.toString(), e.out, `${e.kind} ${e.amount}`);
  }
  // Quotes are pure: repeating one after others gives the same answer (no state leakage).
  assert.equal(v.quoteBuy(1_000_000_000n), v.quoteBuy(1_000_000_000n));
  assert.equal(v.oracle.quote("buy", 1_000_000_000n).out?.toString(), rows.find((r: { amount: string; kind: string }) => r.kind === "buy" && r.amount === "1000000000").out);
  // Guards / disallowed inputs.
  assert.equal(v.quoteBuy(0n), null);
  assert.equal(v.quoteBuy(99_999n), null); // below min trade (100000 lamports)
  assert.equal(v.quoteSell(v.market!.supply + 1n), null);
  // Fast (approximate) quotes are close to exact.
  const x = 3_333_333_333n;
  const fast = v.quoteBuyFast(x)!, exact = v.quoteBuy(x)!;
  assert.ok(Math.abs(Number(fast - exact)) / Number(exact) < 1e-4);
  v.close();
});

test("a crashing/failing worker never breaks later valid quotes", () => {
  const v = new RiseNative();
  v.update(snap.slot, snapshotInfos(v));
  const want = v.oracle.quote("sell", 1_000_000_000n).out;
  for (let i = 0; i < 12; i++) {
    v.oracle.quote("sell", 1n); // DustTrade program error (the path after which litesvm may abort)
    v.oracle.quote("sell", 10n ** 18n);
    assert.equal(v.oracle.quote("sell", 1_000_000_000n).out, want);
  }
  v.close();
});
