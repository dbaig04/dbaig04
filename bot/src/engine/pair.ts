// Transaction builder for a generic pair round trip (pair-optimizer.ts PairPlan):
//   SetComputeUnitLimit, SetComputeUnitPrice,
//   leg 1: exact-in BUY  on the buy venue  (amountIn = grossIn, min-out = quoted tokens),
//   leg 2: exact-in SELL on the sell venue (amountIn = exactly those tokens,
//          min-out = lamportsIn + minOutPad + base + priority + tip + floor),
//   [tip transfer when the plan pays a tip].
// The floor is enforced on-chain by leg 2's min-out, net of every execution cost, as in tx.ts.
// Compiled as a legacy message when it fits in a packet, else as v0 with the configured
// address lookup tables (the PumpSwap + DLMM round trip has ~36 distinct accounts).
import { ComputeBudgetProgram, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction, type AddressLookupTableAccount, type Keypair, type TransactionInstruction } from "@solana/web3.js";
import type { ExecFees } from "./fees.js";
import { cuPriceFor, MAX_CU, txFee } from "./tx.js";
import { venuesFor, type PairPlan, type PairVenues } from "./pair-optimizer.js";

export const PACKET_LIMIT = 1232;

export interface PairBuildParams {
  user: PublicKey;
  profitFloorLamports: bigint;
  cuLimit: number;
  recentBlockhash: string;
  execFees: ExecFees;
  signer?: Keypair | null;
  tipAccount?: PublicKey;
  /** Address lookup tables for a v0 message when the legacy message does not fit. */
  lookupTables?: AddressLookupTableAccount[];
}

export interface PairBuiltTx {
  tx: VersionedTransaction;
  plan: PairPlan;
  instructions: TransactionInstruction[];
  /** leg-1 min token out. */
  leg1Limit: bigint;
  finalMinOut: bigint;
  cuLimit: number;
  cuPriceMicroLamports: bigint;
  feeLamports: bigint;
  tipLamports: bigint;
  execCostLamports: bigint;
  recentBlockhash: string;
  version: "legacy" | 0;
  size: number;
}

/** lamportsIn + pad + execution cost + floor; throws if the quote cannot clear it. */
export function pairFinalMinOut(plan: Pick<PairPlan, "lamportsIn" | "lamportsOut" | "minOutPad">, floor: bigint, execCost: bigint): bigint {
  const min = plan.lamportsIn + plan.minOutPad + execCost + floor;
  if (min > plan.lamportsOut) throw new Error(`plan cannot clear floor: quoted out ${plan.lamportsOut} < required ${min}`);
  return min;
}

export function pairLegInstructions(plan: PairPlan, v: PairVenues, user: PublicKey, floor: bigint, execCost: bigint): { ixs: TransactionInstruction[]; leg1Limit: bigint; finalMin: bigint } {
  const finalMin = pairFinalMinOut(plan, floor, execCost);
  const { buy, sell } = venuesFor(plan.direction, v);
  return {
    ixs: [
      ...buy.swapExactInIxs(user, "buy", plan.grossIn, plan.token, plan.buyQuote),
      ...sell.swapExactInIxs(user, "sell", plan.token, finalMin, plan.sellQuote),
    ],
    leg1Limit: plan.token,
    finalMin,
  };
}

function serializedSize(tx: VersionedTransaction): number | null {
  try { return tx.serialize().length; } catch { return null; }
}

/** Compile legacy if it fits, else v0 with lookup tables. Throws when neither fits. */
export function compileFitting(payer: PublicKey, recentBlockhash: string, instructions: TransactionInstruction[], lookupTables: AddressLookupTableAccount[] = []): { tx: VersionedTransaction; version: "legacy" | 0; size: number } {
  const m = new TransactionMessage({ payerKey: payer, recentBlockhash, instructions });
  let legacySize: number | null = null;
  try {
    const tx = new VersionedTransaction(m.compileToLegacyMessage());
    legacySize = serializedSize(tx);
    if (legacySize !== null && legacySize <= PACKET_LIMIT) return { tx, version: "legacy", size: legacySize };
  } catch { /* too many keys for legacy */ }
  const tx = new VersionedTransaction(m.compileToV0Message(lookupTables));
  const size = serializedSize(tx);
  if (size !== null && size <= PACKET_LIMIT) return { tx, version: 0, size };
  throw new Error(`tx too large: legacy ${legacySize ?? "n/a"} B, v0 with ${lookupTables.length} lookup table(s) ${size ?? "n/a"} B > ${PACKET_LIMIT} (configure PAIR_LOOKUP_TABLES)`);
}

export function buildPairTx(plan: PairPlan, v: PairVenues, p: PairBuildParams): PairBuiltTx {
  const ef = p.execFees;
  if (ef.tipLamports > 0n && !p.tipAccount) throw new Error("plan pays a tip but no tip account was given");
  const { ixs, leg1Limit, finalMin } = pairLegInstructions(plan, v, p.user, p.profitFloorLamports, ef.totalLamports);
  const cuLimit = Math.min(MAX_CU, Math.max(1, Math.ceil(p.cuLimit)));
  const price = cuPriceFor(ef.priorityLamports, cuLimit);
  const instructions = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: cuLimit }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: price }),
    ...ixs,
  ];
  if (ef.tipLamports > 0n) instructions.push(SystemProgram.transfer({ fromPubkey: p.user, toPubkey: p.tipAccount!, lamports: ef.tipLamports }));
  const { tx, version, size } = compileFitting(p.user, p.recentBlockhash, instructions, p.lookupTables);
  if (p.signer) {
    if (!p.signer.publicKey.equals(p.user)) throw new Error("signer does not match user");
    tx.sign([p.signer]);
  }
  const feeLamports = txFee(cuLimit, price, ef.baseLamports, 1);
  if (feeLamports + ef.tipLamports > ef.totalLamports) throw new Error(`fee ${feeLamports} + tip ${ef.tipLamports} exceeds budgeted execution cost ${ef.totalLamports}`);
  return { tx, plan, instructions, leg1Limit, finalMinOut: finalMin, cuLimit, cuPriceMicroLamports: price, feeLamports, tipLamports: ef.tipLamports, execCostLamports: ef.totalLamports, recentBlockhash: p.recentBlockhash, version, size };
}

/** Stable key for duplicate protection (same direction, size and snapshot slot => same opportunity). */
export function pairOpportunityKey(p: Pick<PairPlan, "pair" | "direction" | "grossIn" | "token" | "slot">): string {
  return `${p.pair}:${p.direction}:${p.grossIn}:${p.token}@${p.slot}`;
}

export function pairPlanRecord(p: PairPlan) {
  return {
    pair: p.pair, direction: p.direction, slot: p.slot, buyVenue: p.buyVenue, sellVenue: p.sellVenue,
    grossIn: p.grossIn, lamportsIn: p.lamportsIn, token: p.token, lamportsOut: p.lamportsOut,
    grossProfit: p.grossProfit, fees: p.fees, expectedProfit: p.expectedProfit, minOutPad: p.minOutPad, tokenResidual: p.tokenResidual,
  };
}
