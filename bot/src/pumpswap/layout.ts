// Account decoders for the PumpSwap AMM (pump_amm, pAMMBay6...), written against the IDL shipped in
// @pump-fun/pump-swap-sdk 2.2.0 (src/idl/pump_amm.json; trimmed copy in
// fixtures/pumpswap/pump_amm-idl-2.2.0.trimmed.json). Borsh layouts; offsets include the 8-byte
// Anchor discriminator. Cross-checked against an IDL-driven decoder in test/pumpswap.test.ts.
import { PublicKey } from "@solana/web3.js";

export const POOL_DISC = Buffer.from([241, 154, 109, 4, 17, 177, 109, 188]);
export const GLOBAL_CONFIG_DISC = Buffer.from([149, 8, 156, 202, 160, 252, 176, 217]);
export const FEE_CONFIG_DISC = Buffer.from([143, 52, 146, 187, 219, 123, 76, 155]);

const pk = (b: Buffer, o: number) => new PublicKey(b.subarray(o, o + 32));
const i128 = (d: Buffer, o: number) => BigInt.asIntN(128, d.readBigUInt64LE(o) | (d.readBigUInt64LE(o + 8) << 64n));
const u128 = (d: Buffer, o: number) => d.readBigUInt64LE(o) | (d.readBigUInt64LE(o + 8) << 64n);

export interface PoolState {
  poolBump: number;
  index: number;
  creator: PublicKey;
  baseMint: PublicKey;
  quoteMint: PublicKey;
  lpMint: PublicKey;
  poolBaseTokenAccount: PublicKey;
  poolQuoteTokenAccount: PublicKey;
  lpSupply: bigint;
  coinCreator: PublicKey;
  isMayhemMode: boolean;
  isCashbackCoin: boolean;
  /** Added to the quote vault balance in all pricing (boost pools; 0 otherwise). Signed. */
  virtualQuoteReserves: bigint;
  creatorFeeBps: bigint;
  canEditCreatorFee: boolean;
  isHolderReward: boolean;
  /** v2-trade fee buckets left in the quote vault (paid out by the sweeps). */
  protocolFees: bigint;
  creatorFees: bigint;
}

/** Pool account. Pre-upgrade pools are shorter; missing trailing fields decode as 0/false. */
export function decodePool(d: Buffer): PoolState {
  if (d.length < 211 || !d.subarray(0, 8).equals(POOL_DISC)) throw new Error("not a PumpSwap Pool account");
  const has = (o: number, n: number) => d.length >= o + n;
  return {
    poolBump: d.readUInt8(8),
    index: d.readUInt16LE(9),
    creator: pk(d, 11),
    baseMint: pk(d, 43),
    quoteMint: pk(d, 75),
    lpMint: pk(d, 107),
    poolBaseTokenAccount: pk(d, 139),
    poolQuoteTokenAccount: pk(d, 171),
    lpSupply: d.readBigUInt64LE(203),
    coinCreator: has(211, 32) ? pk(d, 211) : PublicKey.default,
    isMayhemMode: has(243, 1) ? d[243] !== 0 : false,
    isCashbackCoin: has(244, 1) ? d[244] !== 0 : false,
    virtualQuoteReserves: has(245, 16) ? i128(d, 245) : 0n,
    creatorFeeBps: has(261, 8) ? d.readBigUInt64LE(261) : 0n,
    canEditCreatorFee: has(269, 1) ? d[269] !== 0 : false,
    isHolderReward: has(270, 1) ? d[270] !== 0 : false,
    protocolFees: has(271, 8) ? d.readBigUInt64LE(271) : 0n,
    creatorFees: has(279, 8) ? d.readBigUInt64LE(279) : 0n,
  };
}

export interface GlobalConfigState {
  admin: PublicKey;
  lpFeeBps: bigint;
  protocolFeeBps: bigint;
  /** bit0 create pool, bit1 deposit, bit2 withdraw, bit3 buy, bit4 sell */
  disableFlags: number;
  protocolFeeRecipients: PublicKey[];
  coinCreatorFeeBps: bigint;
  reservedFeeRecipient: PublicKey;
  mayhemModeEnabled: boolean;
  isCashbackEnabled: boolean;
  buybackFeeRecipients: PublicKey[];
  /** Share (bps of the protocol fee) of a v2 trade's protocol fee paid out to a buyback recipient. */
  buybackBps: bigint;
  boostEnabled: boolean;
  creatorFeeConfigurable: boolean;
  maxConfigurableCreatorFeeBps: bigint;
}

export function decodeGlobalConfig(d: Buffer): GlobalConfigState {
  if (d.length < 949 || !d.subarray(0, 8).equals(GLOBAL_CONFIG_DISC)) throw new Error("not a PumpSwap GlobalConfig account");
  const arr = (o: number, n: number) => Array.from({ length: n }, (_, i) => pk(d, o + 32 * i));
  return {
    admin: pk(d, 8),
    lpFeeBps: d.readBigUInt64LE(40),
    protocolFeeBps: d.readBigUInt64LE(48),
    disableFlags: d.readUInt8(56),
    protocolFeeRecipients: arr(57, 8),
    coinCreatorFeeBps: d.readBigUInt64LE(313),
    // admin_set_coin_creator_authority @321, whitelist_pda @353
    reservedFeeRecipient: pk(d, 385),
    mayhemModeEnabled: d[417] !== 0,
    // reserved_fee_recipients[7] @418
    isCashbackEnabled: d[642] !== 0,
    buybackFeeRecipients: arr(643, 8),
    buybackBps: d.readBigUInt64LE(899),
    // boost_authority @907
    boostEnabled: d[939] !== 0,
    creatorFeeConfigurable: d[940] !== 0,
    maxConfigurableCreatorFeeBps: d.readBigUInt64LE(941),
  };
}

export interface Fees {
  lpFeeBps: bigint;
  protocolFeeBps: bigint;
  creatorFeeBps: bigint;
}
export interface FeeTier {
  marketCapLamportsThreshold: bigint;
  fees: Fees;
}
export interface FeeConfigState {
  admin: PublicKey;
  flatFees: Fees;
  feeTiers: FeeTier[];
  stableFeeTiers: FeeTier[];
  exoticFlatFees: Fees;
}

/** pump-fees FeeConfig (owner pfeeUxB6..., PDA ["fee_config", pump_amm program id]). */
export function decodeFeeConfig(d: Buffer): FeeConfigState {
  if (!d.subarray(0, 8).equals(FEE_CONFIG_DISC)) throw new Error("not a pump-fees FeeConfig account");
  let o = 8 + 1; // bump
  const admin = pk(d, o);
  o += 32;
  const fees = (): Fees => {
    const f = { lpFeeBps: d.readBigUInt64LE(o), protocolFeeBps: d.readBigUInt64LE(o + 8), creatorFeeBps: d.readBigUInt64LE(o + 16) };
    o += 24;
    return f;
  };
  const tiers = (): FeeTier[] => {
    const n = d.readUInt32LE(o);
    o += 4;
    if (n > 256) throw new Error("FeeConfig: implausible tier count");
    const out: FeeTier[] = [];
    for (let i = 0; i < n; i++) {
      const t = u128(d, o);
      o += 16;
      out.push({ marketCapLamportsThreshold: t, fees: fees() });
    }
    return out;
  };
  const flatFees = fees();
  const feeTiers = tiers();
  // An account written before the field existed decodes stable tiers as [] and exotic fees as 0.
  const stableFeeTiers = o + 4 <= d.length ? tiers() : [];
  const exoticFlatFees = o + 24 <= d.length ? fees() : { lpFeeBps: 0n, protocolFeeBps: 0n, creatorFeeBps: 0n };
  return { admin, flatFees, feeTiers, stableFeeTiers, exoticFlatFees };
}

/** SPL / Token-2022 token account amount. */
export function tokenAmount(d: Buffer): bigint {
  return d.readBigUInt64LE(64);
}

/** SPL / Token-2022 mint supply. */
export function mintSupply(d: Buffer): bigint {
  return d.readBigUInt64LE(36);
}
