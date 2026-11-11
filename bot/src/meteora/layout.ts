// Zero-copy (bytemuck) account decoders for the Meteora DLMM program, written against the
// IDL shipped in @meteora-ag/dlmm 1.9.14 (src/dlmm/idl/idl.json). Offsets include the 8-byte
// Anchor discriminator. Cross-checked against the SDK's Anchor coder in test/meteora.test.ts.
import { PublicKey } from "@solana/web3.js";

export const LB_PAIR_DISC = Buffer.from([33, 11, 49, 98, 181, 101, 177, 13]);
export const BIN_ARRAY_DISC = Buffer.from([92, 142, 92, 220, 5, 148, 70, 181]);

export interface StaticParams {
  baseFactor: number;
  filterPeriod: number;
  decayPeriod: number;
  reductionFactor: number;
  variableFeeControl: number;
  maxVolatilityAccumulator: number;
  minBinId: number;
  maxBinId: number;
  protocolShare: number;
  baseFeePowerFactor: number;
  functionType: number;
  collectFeeMode: number;
}

export interface VariableParams {
  volatilityAccumulator: number;
  volatilityReference: number;
  indexReference: number;
  lastUpdateTimestamp: bigint;
}

export interface LbPairState {
  s: StaticParams;
  v: VariableParams;
  pairType: number;
  activeId: number;
  binStep: number;
  status: number;
  activationType: number;
  tokenXMint: PublicKey;
  tokenYMint: PublicKey;
  reserveX: PublicKey;
  reserveY: PublicKey;
  rewardMints: [PublicKey, PublicKey];
  oracle: PublicKey;
  /** 16 x u64 internal bin array bitmap, bit i <-> bin array index i - 512. */
  binArrayBitmap: bigint[];
  preActivationSwapAddress: PublicKey;
  activationPoint: bigint;
  preActivationDuration: bigint;
  tokenMintXProgramFlag: number;
  tokenMintYProgramFlag: number;
}

const pk = (b: Buffer, o: number) => new PublicKey(b.subarray(o, o + 32));

export function decodeLbPair(d: Buffer): LbPairState {
  if (d.length < 904 || !d.subarray(0, 8).equals(LB_PAIR_DISC)) throw new Error("not an LbPair account");
  const s: StaticParams = {
    baseFactor: d.readUInt16LE(8),
    filterPeriod: d.readUInt16LE(10),
    decayPeriod: d.readUInt16LE(12),
    reductionFactor: d.readUInt16LE(14),
    variableFeeControl: d.readUInt32LE(16),
    maxVolatilityAccumulator: d.readUInt32LE(20),
    minBinId: d.readInt32LE(24),
    maxBinId: d.readInt32LE(28),
    protocolShare: d.readUInt16LE(32),
    baseFeePowerFactor: d.readUInt8(34),
    functionType: d.readUInt8(35),
    collectFeeMode: d.readUInt8(36),
  };
  const v: VariableParams = {
    volatilityAccumulator: d.readUInt32LE(40),
    volatilityReference: d.readUInt32LE(44),
    indexReference: d.readInt32LE(48),
    lastUpdateTimestamp: d.readBigInt64LE(56),
  };
  const bitmap: bigint[] = [];
  for (let i = 0; i < 16; i++) bitmap.push(d.readBigUInt64LE(584 + 8 * i));
  return {
    s,
    v,
    pairType: d.readUInt8(75),
    activeId: d.readInt32LE(76),
    binStep: d.readUInt16LE(80),
    status: d.readUInt8(82),
    activationType: d.readUInt8(86),
    tokenXMint: pk(d, 88),
    tokenYMint: pk(d, 120),
    reserveX: pk(d, 152),
    reserveY: pk(d, 184),
    // reward_infos @264, 2 x 144 bytes, mint is the first field
    rewardMints: [pk(d, 264), pk(d, 264 + 144)],
    oracle: pk(d, 552),
    binArrayBitmap: bitmap,
    preActivationSwapAddress: pk(d, 752),
    activationPoint: d.readBigUInt64LE(816),
    preActivationDuration: d.readBigUInt64LE(824),
    tokenMintXProgramFlag: d.readUInt8(880),
    tokenMintYProgramFlag: d.readUInt8(881),
  };
}

export interface Bin {
  amountX: bigint;
  amountY: bigint;
  price: bigint; // Q64.64
  openOrderAmount: bigint;
  processedOrderRemainingAmount: bigint;
  limitOrderAskSide: boolean;
}

export const MAX_BIN_PER_ARRAY = 70;
const BIN_SIZE = 144;
const BINS_OFFSET = 56;
export const BIN_ARRAY_SIZE = BINS_OFFSET + MAX_BIN_PER_ARRAY * BIN_SIZE; // 10136

export interface BinArrayState {
  index: number;
  version: number;
  lbPair: PublicKey;
  bins: Bin[];
}

const u128 = (d: Buffer, o: number) => d.readBigUInt64LE(o) | (d.readBigUInt64LE(o + 8) << 64n);

export function decodeBinArray(d: Buffer): BinArrayState {
  if (d.length < BIN_ARRAY_SIZE || !d.subarray(0, 8).equals(BIN_ARRAY_DISC)) throw new Error("not a BinArray account");
  const index = Number(d.readBigInt64LE(8));
  const version = d.readUInt8(16);
  const bins: Bin[] = new Array(MAX_BIN_PER_ARRAY);
  for (let i = 0; i < MAX_BIN_PER_ARRAY; i++) {
    const o = BINS_OFFSET + i * BIN_SIZE;
    bins[i] = {
      amountX: d.readBigUInt64LE(o),
      amountY: d.readBigUInt64LE(o + 8),
      price: u128(d, o + 16),
      openOrderAmount: d.readBigUInt64LE(o + 112),
      processedOrderRemainingAmount: d.readBigUInt64LE(o + 128),
      limitOrderAskSide: d.readUInt8(o + 140) !== 0,
    };
  }
  return { index, version, lbPair: pk(d, 24), bins };
}

export interface ClockState {
  slot: bigint;
  epochStartTimestamp: bigint;
  epoch: bigint;
  leaderScheduleEpoch: bigint;
  unixTimestamp: bigint;
}

export function decodeClock(d: Buffer): ClockState {
  return {
    slot: d.readBigUInt64LE(0),
    epochStartTimestamp: d.readBigInt64LE(8),
    epoch: d.readBigUInt64LE(16),
    leaderScheduleEpoch: d.readBigUInt64LE(24),
    unixTimestamp: d.readBigInt64LE(32),
  };
}

export function decodeTokenAmount(d: Buffer): bigint {
  return d.readBigUInt64LE(64);
}

// ---- Token-2022 mint extensions ----
export interface TransferFeeParams {
  epoch: bigint;
  maximumFee: bigint;
  basisPoints: number;
}
export interface MintInfo {
  decimals: number;
  extensions: number[];
  transferFee: { older: TransferFeeParams; newer: TransferFeeParams } | null;
  transferHookProgram: PublicKey | null;
}

const EXT_TRANSFER_FEE_CONFIG = 1;
const EXT_TRANSFER_HOOK = 14;

/** Parses an SPL Token or Token-2022 mint (base 82 bytes, account type byte at 165, TLV from 166). */
export function decodeMint(d: Buffer): MintInfo {
  const decimals = d.readUInt8(44);
  const out: MintInfo = { decimals, extensions: [], transferFee: null, transferHookProgram: null };
  if (d.length <= 165) return out;
  let o = 166;
  while (o + 4 <= d.length) {
    const t = d.readUInt16LE(o);
    const len = d.readUInt16LE(o + 2);
    if (t === 0 && len === 0) break;
    const v = d.subarray(o + 4, o + 4 + len);
    out.extensions.push(t);
    if (t === EXT_TRANSFER_FEE_CONFIG) {
      // authority(32) withdraw authority(32) withheld u64, older TransferFee, newer TransferFee
      const tf = (p: number): TransferFeeParams => ({
        epoch: v.readBigUInt64LE(p),
        maximumFee: v.readBigUInt64LE(p + 8),
        basisPoints: v.readUInt16LE(p + 16),
      });
      out.transferFee = { older: tf(72), newer: tf(90) };
    } else if (t === EXT_TRANSFER_HOOK) {
      const prog = new PublicKey(v.subarray(32, 64));
      out.transferHookProgram = prog.equals(PublicKey.default) ? null : prog;
    }
    o += 4 + len;
  }
  return out;
}
