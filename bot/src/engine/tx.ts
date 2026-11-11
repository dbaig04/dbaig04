// Builds the single atomic arb tx: SetComputeUnitLimit + SetComputeUnitPrice,
// then the two legs [+ tip transfer when the plan pays a tip]. Leg mins:
//  - leg-1 intermediate: exactly the quoted amount (or quoted - slippage bps)
//  - final leg min-out:  lamportsIn + minOutPad + execution costs (base + priority + tip)
//    + profitFloor, enforced on-chain, so a landed tx is net-profitable by at least the
//    floor after every cost. lamportsIn is the NET wSOL spend (buyThenRedeem: DLMM max-in
//    minus the host-fee rebate the user's own input account receives).
import { ComputeBudgetProgram, PublicKey, SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction, type Keypair } from "@solana/web3.js";
import type { Plan, Venues } from "./optimizer.js";
import type { ExecFees } from "./fees.js";
export { chooseExecutionFees, netAfterExecution, minGrossForNet, type ExecFeePolicy, type ExecFees } from "./fees.js";

export const MAX_CU = 1_400_000;
/** CU limit used for the pre-flight simulation (actual limit is set from the sim). */
export const SIM_CU = MAX_CU;

export interface FeeParams {
  priorityFeeLamports: bigint;
  baseFeeLamports: bigint;
  /** Number of signatures (1 for a single fee payer). */
  signatures?: number;
}

/** Micro-lamports/CU so the priority fee ~= target (never above it). */
export function cuPriceFor(priorityFeeLamports: bigint, cuLimit: number): bigint {
  if (cuLimit <= 0) throw new Error("cuLimit must be > 0");
  return (priorityFeeLamports * 1_000_000n) / BigInt(cuLimit);
}

/** Exact fee the runtime will charge for this CU limit/price. */
export function txFee(cuLimit: number, cuPriceMicroLamports: bigint, baseFeeLamports: bigint, signatures = 1): bigint {
  const prio = (BigInt(cuLimit) * cuPriceMicroLamports + 999_999n) / 1_000_000n;
  return baseFeeLamports * BigInt(signatures) + prio;
}

/** Upper bound on the tx cost used in min-out and optimizer (base + full priority target). */
export function estimatedTxCost(f: FeeParams): bigint {
  return f.baseFeeLamports * BigInt(f.signatures ?? 1) + f.priorityFeeLamports;
}

export interface BuildParams extends FeeParams {
  user: PublicKey;
  profitFloorLamports: bigint;
  cuLimit: number;
  recentBlockhash: string;
  signer?: Keypair | null;
  /**
   * Execution costs chosen for this trade (normally plan.fees). When set they override
   * priorityFeeLamports/baseFeeLamports for the CU price, the fee check and the min-out.
   */
  execFees?: ExecFees;
  /** Tip receiver (required iff execFees.tipLamports > 0; e.g. a Jito tip account). */
  tipAccount?: PublicKey;
}

export interface BuiltTx {
  tx: VersionedTransaction;
  plan: Plan;
  instructions: TransactionInstruction[];
  /** leg-1 min out (mintThenSell: RISE) or leg-1 max in (buyThenRedeem: lamports). */
  leg1Limit: bigint;
  /** Final leg min lamports out. */
  finalMinOut: bigint;
  cuLimit: number;
  cuPriceMicroLamports: bigint;
  feeLamports: bigint;
  /** Tip transferred (0 without a tip ix). */
  tipLamports: bigint;
  /** base + priority + tip budgeted in the min-out. */
  execCostLamports: bigint;
  recentBlockhash: string;
}

/**
 * Final min-out = lamportsIn + minOutPad + execCost + floor, where execCost is the full
 * execution cost of this tx (base + priority + tip). Throws if the quote cannot satisfy it.
 */
export function finalMinOut(plan: Pick<Plan, "lamportsIn" | "lamportsOut"> & { minOutPad?: bigint }, profitFloor: bigint, txCost: bigint): bigint {
  const min = plan.lamportsIn + (plan.minOutPad ?? 0n) + profitFloor + txCost;
  if (min > plan.lamportsOut) throw new Error(`plan cannot clear floor: quoted out ${plan.lamportsOut} < required ${min}`);
  return min;
}

export function legInstructions(plan: Plan, v: Venues, user: PublicKey, profitFloor: bigint, txCost: bigint): { ixs: TransactionInstruction[]; leg1Limit: bigint; finalMin: bigint } {
  const finalMin = finalMinOut(plan, profitFloor, txCost);
  if (plan.direction === "mintThenSell") {
    // plan.rise already = quote (or quote - slippage); it is both leg-1 min and leg-2 exact input,
    // so leg 2 never tries to sell more RISE than leg 1 guarantees.
    return {
      ixs: [
        v.rise.buyIx(user, plan.lamportsIn, plan.rise),
        v.dlmm.swapExactInIx(user, "sellRise", plan.rise, finalMin, plan.binArrays),
      ],
      leg1Limit: plan.rise,
      finalMin,
    };
  }
  // plan.grossIn = quoted exact-out gross input (+ slippage) = DLMM max-in.
  const maxIn = plan.grossIn ?? plan.lamportsIn;
  return {
    ixs: [
      v.dlmm.swapExactOutIx(user, "buyRise", plan.rise, maxIn, plan.binArrays),
      v.rise.sellIx(user, plan.rise, finalMin),
    ],
    leg1Limit: maxIn,
    finalMin,
  };
}

export function buildArbTx(plan: Plan, v: Venues, p: BuildParams): BuiltTx {
  const ef = p.execFees;
  const priority = ef ? ef.priorityLamports : p.priorityFeeLamports;
  const base = ef ? ef.baseLamports : p.baseFeeLamports * BigInt(p.signatures ?? 1);
  const tip = ef ? ef.tipLamports : 0n;
  const txCost = ef ? ef.totalLamports : estimatedTxCost(p);
  if (tip > 0n && !p.tipAccount) throw new Error("plan pays a tip but no tip account was given");
  const { ixs, leg1Limit, finalMin } = legInstructions(plan, v, p.user, p.profitFloorLamports, txCost);
  const cuLimit = Math.min(MAX_CU, Math.max(1, Math.ceil(p.cuLimit)));
  const price = cuPriceFor(priority, cuLimit);
  const instructions = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: cuLimit }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: price }),
    ...ixs,
  ];
  if (tip > 0n) instructions.push(SystemProgram.transfer({ fromPubkey: p.user, toPubkey: p.tipAccount!, lamports: tip }));
  const msg = new TransactionMessage({ payerKey: p.user, recentBlockhash: p.recentBlockhash, instructions }).compileToLegacyMessage();
  const tx = new VersionedTransaction(msg);
  if (p.signer) {
    if (!p.signer.publicKey.equals(p.user)) throw new Error("signer does not match user");
    tx.sign([p.signer]);
  }
  const feeLamports = txFee(cuLimit, price, ef ? base : p.baseFeeLamports, ef ? 1 : p.signatures ?? 1);
  if (feeLamports + tip > txCost) throw new Error(`fee ${feeLamports} + tip ${tip} exceeds budgeted execution cost ${txCost}`);
  return { tx, plan, instructions, leg1Limit, finalMinOut: finalMin, cuLimit, cuPriceMicroLamports: price, feeLamports, tipLamports: tip, execCostLamports: txCost, recentBlockhash: p.recentBlockhash };
}

/** CU limit from simulated usage with headroom (bps, 11500 = 1.15x). */
export function cuFromSim(unitsConsumed: number, headroomBps: bigint): number {
  const cu = Math.ceil((unitsConsumed * Number(headroomBps)) / 10_000);
  return Math.min(MAX_CU, Math.max(cu, 1));
}
