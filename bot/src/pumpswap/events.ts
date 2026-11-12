// BuyEvent / SellEvent decoding (Anchor events, emitted as "Program data: <base64>" log lines and via
// the self-CPI to the event authority). Field order from the pump_amm IDL (SDK 2.2.0).
import bs58 from "bs58";
import { PublicKey } from "@solana/web3.js";

export const BUY_EVENT_DISC = Buffer.from([103, 244, 82, 31, 44, 245, 119, 119]);
export const SELL_EVENT_DISC = Buffer.from([62, 47, 55, 10, 165, 3, 220, 42]);
const ANCHOR_EVENT_IX_TAG = Buffer.from("e445a52e51cb9a1d", "hex");

type FieldT = "u64" | "i64" | "i128" | "bool" | "pubkey" | "string";
const BUY_FIELDS: [string, FieldT][] = [
  ["timestamp", "i64"], ["baseAmountOut", "u64"], ["maxQuoteAmountIn", "u64"], ["userBaseTokenReserves", "u64"],
  ["userQuoteTokenReserves", "u64"], ["poolBaseTokenReserves", "u64"], ["poolQuoteTokenReserves", "u64"], ["quoteAmountIn", "u64"],
  ["lpFeeBasisPoints", "u64"], ["lpFee", "u64"], ["protocolFeeBasisPoints", "u64"], ["protocolFee", "u64"],
  ["quoteAmountInWithLpFee", "u64"], ["userQuoteAmountIn", "u64"], ["pool", "pubkey"], ["user", "pubkey"],
  ["userBaseTokenAccount", "pubkey"], ["userQuoteTokenAccount", "pubkey"], ["protocolFeeRecipient", "pubkey"],
  ["protocolFeeRecipientTokenAccount", "pubkey"], ["coinCreator", "pubkey"], ["coinCreatorFeeBasisPoints", "u64"],
  ["coinCreatorFee", "u64"], ["trackVolume", "bool"], ["totalUnclaimedTokens", "u64"], ["totalClaimedTokens", "u64"],
  ["currentSolVolume", "u64"], ["lastUpdateTimestamp", "i64"], ["minBaseAmountOut", "u64"], ["ixName", "string"],
  ["cashbackFeeBasisPoints", "u64"], ["cashback", "u64"], ["buybackFeeBasisPoints", "u64"], ["buybackFee", "u64"],
  ["virtualQuoteReserves", "i128"], ["canBoost", "bool"], ["baseSupply", "u64"], ["holderRewardsBps", "u64"],
  ["holderRewards", "u64"], ["creatorFeeUnclaimed", "u64"], ["quoteTransferFee", "u64"],
];
const SELL_FIELDS: [string, FieldT][] = [
  ["timestamp", "i64"], ["baseAmountIn", "u64"], ["minQuoteAmountOut", "u64"], ["userBaseTokenReserves", "u64"],
  ["userQuoteTokenReserves", "u64"], ["poolBaseTokenReserves", "u64"], ["poolQuoteTokenReserves", "u64"], ["quoteAmountOut", "u64"],
  ["lpFeeBasisPoints", "u64"], ["lpFee", "u64"], ["protocolFeeBasisPoints", "u64"], ["protocolFee", "u64"],
  ["quoteAmountOutWithoutLpFee", "u64"], ["userQuoteAmountOut", "u64"], ["pool", "pubkey"], ["user", "pubkey"],
  ["userBaseTokenAccount", "pubkey"], ["userQuoteTokenAccount", "pubkey"], ["protocolFeeRecipient", "pubkey"],
  ["protocolFeeRecipientTokenAccount", "pubkey"], ["coinCreator", "pubkey"], ["coinCreatorFeeBasisPoints", "u64"],
  ["coinCreatorFee", "u64"], ["cashbackFeeBasisPoints", "u64"], ["cashback", "u64"], ["buybackFeeBasisPoints", "u64"],
  ["buybackFee", "u64"], ["virtualQuoteReserves", "i128"], ["canBoost", "bool"], ["baseSupply", "u64"],
  ["holderRewardsBps", "u64"], ["holderRewards", "u64"], ["creatorFeeUnclaimed", "u64"], ["quoteTransferFee", "u64"],
];

export type PumpEvent = { kind: "buy" | "sell"; [k: string]: any };

function decodeFields(d: Buffer, fields: [string, FieldT][]): Record<string, any> {
  let o = 0;
  const r: Record<string, any> = {};
  for (const [name, t] of fields) {
    if (o >= d.length) break; // older event versions are shorter
    switch (t) {
      case "u64": r[name] = d.readBigUInt64LE(o); o += 8; break;
      case "i64": r[name] = d.readBigInt64LE(o); o += 8; break;
      case "i128": r[name] = BigInt.asIntN(128, d.readBigUInt64LE(o) | (d.readBigUInt64LE(o + 8) << 64n)); o += 16; break;
      case "bool": r[name] = d[o] !== 0; o += 1; break;
      case "pubkey": r[name] = new PublicKey(d.subarray(o, o + 32)).toBase58(); o += 32; break;
      case "string": { const n = d.readUInt32LE(o); r[name] = d.subarray(o + 4, o + 4 + n).toString("utf8"); o += 4 + n; break; }
    }
  }
  return r;
}

/** Decode an event body (8-byte event discriminator + fields). */
export function decodePumpEvent(b: Buffer): PumpEvent | null {
  if (b.length < 8) return null;
  const disc = b.subarray(0, 8);
  if (disc.equals(BUY_EVENT_DISC)) return { kind: "buy", ...decodeFields(b.subarray(8), BUY_FIELDS) };
  if (disc.equals(SELL_EVENT_DISC)) return { kind: "sell", ...decodeFields(b.subarray(8), SELL_FIELDS) };
  return null;
}

/** All Buy/Sell events in a tx's (or simulation's) log messages. */
export function pumpEventsFromLogs(logs: string[] | null | undefined): PumpEvent[] {
  const out: PumpEvent[] = [];
  for (const l of logs ?? []) {
    if (!l.startsWith("Program data: ")) continue;
    const e = decodePumpEvent(Buffer.from(l.slice(14), "base64"));
    if (e) out.push(e);
  }
  return out;
}

/** Same, from self-CPI inner instruction data (base58), for txs whose logs were truncated. */
export function pumpEventFromInnerIxData(data58: string): PumpEvent | null {
  const d = Buffer.from(bs58.decode(data58));
  if (d.length < 16 || !d.subarray(0, 8).equals(ANCHOR_EVENT_IX_TAG)) return null;
  return decodePumpEvent(d.subarray(8));
}
