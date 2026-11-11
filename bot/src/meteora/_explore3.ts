import { ComputeBudgetProgram, PublicKey, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { MeteoraDlmm } from "./index.js";
import { getMultipleAccounts, rpc } from "./rpc.js";
import { decodeLbPair, decodeBinArray } from "./layout.js";
import { POOL, binArrayPda } from "./pda.js";
const REF = new PublicKey("24Q5e2FRebiFs3iWvN6pZYA4UTGzA3WUsci4ChhgfYEU");
const SELLER = new PublicKey("72wotPiwDKz1rf3xdf4hVExjfeuGgR4wQGrHpmobJhHC");
const v = new MeteoraDlmm();
let s = await getMultipleAccounts(v.accounts()); v.update(s.slot, s.infos);
s = await getMultipleAccounts(v.accounts()); v.update(s.slot, s.infos);
const side = process.argv[2] as any; const amt = BigInt(process.argv[3]);
const user = side === "buyRise" ? REF : SELLER;
const q = v.quoteExactIn(side, amt)!;
console.log("quote", q);
const ba = binArrayPda(-11);
const tx = new VersionedTransaction(new TransactionMessage({ payerKey: user, recentBlockhash: PublicKey.default.toBase58(), instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), v.swapExactInIx(user, side, amt, 0n, q.binArrays)] }).compileToV0Message());
const sim: any = await rpc("simulateTransaction", [Buffer.from(tx.serialize()).toString("base64"), { encoding: "base64", sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed", accounts: { encoding: "base64", addresses: [POOL.toBase58(), ba.toBase58()] } }]);
const after = await getMultipleAccounts(v.accounts());
console.log("stable", after.infos.get(POOL.toBase58())!.data.equals(s.infos.get(POOL.toBase58())!.data), sim.value.err);
const lp0 = decodeLbPair(s.infos.get(POOL.toBase58())!.data), lp1 = decodeLbPair(Buffer.from(sim.value.accounts[0].data[0], "base64"));
console.log("pre", lp0.activeId, lp0.v, "post", lp1.activeId, lp1.v);
const d0 = s.infos.get(POOL.toBase58())!.data, d1 = Buffer.from(sim.value.accounts[0].data[0], "base64");
for (let i = 0; i < d0.length; i++) if (d0[i] !== d1[i]) process.stdout.write(i + " ");
console.log();
const b0 = decodeBinArray(s.infos.get(ba.toBase58())!.data), b1 = decodeBinArray(Buffer.from(sim.value.accounts[1].data[0], "base64"));
const raw0 = s.infos.get(ba.toBase58())!.data, raw1 = Buffer.from(sim.value.accounts[1].data[0], "base64");
for (let j = 0; j < 70; j++) {
  const o = 56 + j * 144;
  if (!raw0.subarray(o, o + 144).equals(raw1.subarray(o, o + 144))) {
    const chg: number[] = []; for (let k = 0; k < 144; k += 8) if (!raw0.subarray(o + k, o + k + 8).equals(raw1.subarray(o + k, o + k + 8))) chg.push(k);
    console.log("bin", -770 + j, "x", b0.bins[j].amountX, "->", b1.bins[j].amountX, "y", b0.bins[j].amountY, "->", b1.bins[j].amountY, "changed offsets", chg);
  }
}
