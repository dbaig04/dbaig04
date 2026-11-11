import { test } from "node:test";
import assert from "node:assert/strict";
import { ComputeBudgetProgram, Keypair, PublicKey } from "@solana/web3.js";
import { optimizeDirection } from "../src/engine/optimizer.js";
import { buildArbTx, cuFromSim, cuPriceFor, estimatedTxCost, finalMinOut, txFee } from "../src/engine/tx.js";
import { CpDlmm, decodeFakeIx, LinearRise } from "./engine-fakes.js";

const FEES = { priorityFeeLamports: 50_000n, baseFeeLamports: 5_000n };
const BH = "11111111111111111111111111111111";

test("fee math reproduces the reference wallet's 55,001 lamport fee", () => {
  // reference tx: CU limit 430343, price 116187 micro-lamports
  assert.equal(txFee(430_343, 116_187n, 5_000n), 55_001n);
  const cu = 430_343;
  const price = cuPriceFor(50_000n, cu);
  const fee = txFee(cu, price, 5_000n);
  assert.ok(fee <= 55_000n && fee >= 54_999n, String(fee));
  assert.equal(estimatedTxCost(FEES), 55_000n);
  assert.equal(cuFromSim(358_769, 11_500n), 412_585);
  assert.equal(cuFromSim(2_000_000, 11_500n), 1_400_000);
});

test("mintThenSell: CB ixs + Buy(min = quoted RISE) + exact-in swap(min = in + floor + fees)", () => {
  // large-scale pool so the floor is clearable
  const v = { rise: new LinearRise(1_000_000_000n, 10n), dlmm: new CpDlmm(1_000_000_000_000n, 950_000_000_000n, 25n) };
  const p = { profitFloor: 100_000n, txCost: estimatedTxCost(FEES), maxLamportsIn: 5_000_000_000n, minLamportsIn: 1_000_000n, legSlippageBps: 0n };
  const plan = optimizeDirection("mintThenSell", v, p)!;
  assert.ok(plan && plan.expectedProfit >= 100_000n);
  const user = Keypair.generate();
  const b = buildArbTx(plan, v, { ...FEES, user: user.publicKey, profitFloorLamports: 100_000n, cuLimit: 412_585, recentBlockhash: BH, signer: user });
  assert.equal(b.instructions.length, 4);
  assert.ok(b.instructions[0].programId.equals(ComputeBudgetProgram.programId));
  assert.equal(b.instructions[0].data[0], 2); // SetComputeUnitLimit
  assert.equal(b.instructions[0].data.readUInt32LE(1), 412_585);
  assert.equal(b.instructions[1].data[0], 3); // SetComputeUnitPrice
  assert.equal(b.instructions[1].data.readBigUInt64LE(1), b.cuPriceMicroLamports);
  const buy = decodeFakeIx(b.instructions[2]);
  const swap = decodeFakeIx(b.instructions[3]);
  assert.deepEqual(buy, { tag: 1, args: [plan.lamportsIn, plan.leg1Quote] }); // exact quoted RISE as min
  assert.equal(plan.rise, plan.leg1Quote);
  assert.deepEqual(swap, { tag: 3, args: [plan.rise, plan.lamportsIn + 100_000n + 55_000n] });
  assert.ok(b.feeLamports <= 55_000n);
  assert.equal(b.tx.message.version, "legacy");
  assert.ok(b.tx.signatures[0].some((x) => x !== 0));
  assert.ok(b.tx.serialize().length <= 1232);
});

test("buyThenRedeem: exact-out swap(max in = quote) + Sell(min = maxIn + floor + fees)", () => {
  const v = { rise: new LinearRise(1_000_000_000n, 10n), dlmm: new CpDlmm(1_000_000_000_000n, 1_060_000_000_000n, 25n) };
  const p = { profitFloor: 100_000n, txCost: 55_000n, maxLamportsIn: 5_000_000_000n, minLamportsIn: 1_000_000n, legSlippageBps: 0n };
  const plan = optimizeDirection("buyThenRedeem", v, p)!;
  assert.ok(plan);
  const user = PublicKey.unique();
  const b = buildArbTx(plan, v, { ...FEES, user, profitFloorLamports: 100_000n, cuLimit: 200_000, recentBlockhash: BH });
  const swap = decodeFakeIx(b.instructions[2]);
  const sell = decodeFakeIx(b.instructions[3]);
  assert.deepEqual(swap, { tag: 6, args: [plan.rise, plan.leg1Quote] });
  assert.deepEqual(sell, { tag: 2, args: [plan.rise, plan.lamportsIn + 155_000n] });
  assert.ok(b.tx.signatures[0].every((x) => x === 0)); // unsigned (simulate mode)
});

test("slippage keeps the final min-out at lamportsIn + floor + fees", () => {
  const v = { rise: new LinearRise(1_000_000_000n, 10n), dlmm: new CpDlmm(1_000_000_000_000n, 1_060_000_000_000n, 25n) };
  const p = { profitFloor: 100_000n, txCost: 55_000n, maxLamportsIn: 5_000_000_000n, minLamportsIn: 1_000_000n, legSlippageBps: 50n };
  const plan = optimizeDirection("buyThenRedeem", v, p)!;
  const b = buildArbTx(plan, v, { ...FEES, user: PublicKey.unique(), profitFloorLamports: 100_000n, cuLimit: 200_000, recentBlockhash: BH });
  const swap = decodeFakeIx(b.instructions[2]);
  const sell = decodeFakeIx(b.instructions[3]);
  assert.equal(swap.args[1], (plan.leg1Quote * 10_050n + 9_999n) / 10_000n);
  assert.equal(sell.args[1], swap.args[1] + 155_000n);
});

test("finalMinOut refuses a plan that cannot clear the floor", () => {
  const plan = { direction: "mintThenSell" as const, slot: 0, lamportsIn: 1_000_000n, rise: 1n, lamportsOut: 1_100_000n, expectedProfit: 45_000n, txCostLamports: 55_000n, leg1Quote: 1n, binArrays: [] };
  assert.throws(() => finalMinOut(plan, 100_000n, 55_000n), /cannot clear floor/);
  assert.equal(finalMinOut(plan, 45_000n, 55_000n), 1_100_000n);
});
