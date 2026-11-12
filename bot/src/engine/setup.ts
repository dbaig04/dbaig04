// One-time live setup: create the wSOL ATA (classic Token program) and the RISE
// ATA (Token-2022) if missing, and optionally wrap SOL into the wSOL ATA.
//   KEYPAIR_PATH=... WRAP_LAMPORTS=1000000000 npx tsx src/engine/setup.ts
// Prints the tx and simulates it; only sends when CONFIRM=yes is set or the
// operator types CONFIRM at the prompt.
import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";
import { Connection, PublicKey, SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction, createSyncNativeInstruction,
  getAssociatedTokenAddressSync, NATIVE_MINT, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { loadConfig } from "../config.js";
import { MAX_MINT, RISE_MINT } from "../types.js";
import { initUserVolumeAccumulatorIx } from "./pair-venues.js";
import { userVolumeAccumulatorPda } from "../pumpswap/pda.js";

export function atasFor(user: PublicKey): { wsolAta: PublicKey; riseAta: PublicKey } {
  return {
    wsolAta: getAssociatedTokenAddressSync(NATIVE_MINT, user, false, TOKEN_PROGRAM_ID),
    riseAta: getAssociatedTokenAddressSync(new PublicKey(RISE_MINT), user, false, TOKEN_2022_PROGRAM_ID),
  };
}

export function setupInstructions(user: PublicKey, o: { createWsol: boolean; createRise: boolean; wrapLamports: bigint }): TransactionInstruction[] {
  const { wsolAta, riseAta } = atasFor(user);
  const ixs: TransactionInstruction[] = [];
  if (o.createWsol) ixs.push(createAssociatedTokenAccountIdempotentInstruction(user, wsolAta, user, NATIVE_MINT, TOKEN_PROGRAM_ID));
  if (o.createRise) ixs.push(createAssociatedTokenAccountIdempotentInstruction(user, riseAta, user, new PublicKey(RISE_MINT), TOKEN_2022_PROGRAM_ID));
  if (o.wrapLamports > 0n) {
    ixs.push(SystemProgram.transfer({ fromPubkey: user, toPubkey: wsolAta, lamports: o.wrapLamports }));
    ixs.push(createSyncNativeInstruction(wsolAta, TOKEN_PROGRAM_ID));
  }
  return ixs;
}

async function main() {
  const cfg = loadConfig();
  if (!cfg.keypair) throw new Error("setup requires KEYPAIR_PATH");
  const conn = new Connection(cfg.rpcUrl, { commitment: "confirmed", fetch: globalThis.fetch });
  const user = cfg.keypair.publicKey;
  const { wsolAta, riseAta } = atasFor(user);
  const [w, r, bal] = await Promise.all([conn.getAccountInfo(wsolAta), conn.getAccountInfo(riseAta), conn.getBalance(user)]);
  const wrapLamports = BigInt(process.env.WRAP_LAMPORTS ?? "0");
  console.log(`user ${user.toBase58()} native balance ${bal} lamports`);
  console.log(`wSOL ATA ${wsolAta.toBase58()} ${w ? "exists" : "MISSING"}`);
  console.log(`RISE ATA ${riseAta.toBase58()} ${r ? "exists" : "MISSING"} (Token-2022)`);
  if (w && !w.owner.equals(TOKEN_PROGRAM_ID)) throw new Error("wSOL ATA not owned by Token program");
  if (r && !r.owner.equals(TOKEN_2022_PROGRAM_ID)) throw new Error("RISE ATA not owned by Token-2022 program");
  const ixs = setupInstructions(user, { createWsol: !w, createRise: !r, wrapLamports });
  if (cfg.pairs.enabled.includes("max")) {
    // MAX pair: MAX ATA (Token-2022) + PumpSwap user_volume_accumulator (one-time rent; the engine
    // refuses to trade without it so that rent never lands in a trade tx)
    const maxAta = getAssociatedTokenAddressSync(new PublicKey(MAX_MINT), user, false, TOKEN_2022_PROGRAM_ID);
    const uva = userVolumeAccumulatorPda(user);
    const [m, u] = await Promise.all([conn.getAccountInfo(maxAta), conn.getAccountInfo(uva)]);
    console.log(`MAX ATA ${maxAta.toBase58()} ${m ? "exists" : "MISSING"} (Token-2022)`);
    console.log(`PumpSwap user_volume_accumulator ${uva.toBase58()} ${u ? "exists" : "MISSING"}`);
    if (!m) ixs.push(createAssociatedTokenAccountIdempotentInstruction(user, maxAta, user, new PublicKey(MAX_MINT), TOKEN_2022_PROGRAM_ID));
    if (!u) ixs.push(initUserVolumeAccumulatorIx(user));
  }
  if (ixs.length === 0) { console.log("nothing to do"); return; }
  if (BigInt(bal) < wrapLamports + 10_000_000n) throw new Error(`insufficient SOL to wrap ${wrapLamports} and keep fees/rent`);
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  const tx = new VersionedTransaction(new TransactionMessage({ payerKey: user, recentBlockhash: blockhash, instructions: ixs }).compileToLegacyMessage());
  tx.sign([cfg.keypair]);
  console.log("\nsetup tx:");
  for (const ix of ixs) console.log(`  program ${ix.programId.toBase58()} keys=[${ix.keys.map((k) => k.pubkey.toBase58().slice(0, 8)).join(",")}] data=${ix.data.toString("hex")}`);
  if (wrapLamports > 0n) console.log(`  wraps ${wrapLamports} lamports into ${wsolAta.toBase58()}`);
  const sim = await conn.simulateTransaction(tx, { sigVerify: true });
  console.log(`simulation: err=${JSON.stringify(sim.value.err)} units=${sim.value.unitsConsumed}`);
  if (sim.value.err) { console.log((sim.value.logs ?? []).join("\n")); throw new Error("setup simulation failed"); }
  let ok = process.env.CONFIRM === "yes";
  if (!ok) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    ok = (await rl.question("Type CONFIRM to send: ")).trim() === "CONFIRM";
    rl.close();
  }
  if (!ok) { console.log("aborted"); return; }
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  console.log(`sent ${sig}`);
  const res = await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
  console.log(`confirmed: err=${JSON.stringify(res.value.err)}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
}
