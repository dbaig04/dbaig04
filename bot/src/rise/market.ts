// Partial decode of the 725-byte market account. Only fields whose meaning was
// verified (see NOTES.md) are exposed. Quotes do NOT depend on this decode:
// they come from executing the real program (oracle.ts). This is used for
// sanity checks, cheap guards and fee math.

export const MARKET_SIZE = 725;
export const MARKET_DISCRIMINATOR = Buffer.from("dbbed53700e3c69a", "hex");

export interface MarketView {
  marketBump: number;
  vaultBump: number;
  creatorClaimBump: number;
  /** Buy fee, parts per million of lamports_in (12500 = 1.25%). */
  buyFeePpm: number;
  /** Sell fee, parts per million of gross SOL out. */
  sellFeePpm: number;
  /** Share of the fee to creator / team, in bps (5000/5000). */
  creatorShareBps: number;
  teamShareBps: number;
  /** RISE supply as tracked by the market (equals the mint supply). */
  supply: bigint;
  /** Minimum trade in lamports (u64 @267 = 100000). Buy lamports_in below it, or a sell
   * whose gross SOL is below it, fails with custom error 6401 (checked in LiteSVM). */
  minTradeLamports: bigint;
  /** Floor/main cash ledger (lamports). A + B = vault wSOL balance. */
  reserveA: bigint;
  /** Price-reserve ledger (lamports). */
  reserveB: bigint;
  /** Accrued, unclaimed creator fees (lamports). */
  creatorFeesAccrued: bigint;
}

export function decodeMarket(data: Buffer): MarketView {
  if (data.length !== MARKET_SIZE) throw new Error(`market: unexpected size ${data.length}`);
  if (!data.subarray(0, 8).equals(MARKET_DISCRIMINATOR)) throw new Error("market: bad discriminator");
  return {
    marketBump: data[238],
    vaultBump: data[239],
    creatorClaimBump: data[240],
    buyFeePpm: data.readUInt32LE(245),
    sellFeePpm: data.readUInt32LE(249),
    creatorShareBps: data.readUInt16LE(261),
    teamShareBps: data.readUInt16LE(263),
    supply: data.readBigUInt64LE(421),
    minTradeLamports: data.readBigUInt64LE(267),
    reserveA: data.readBigUInt64LE(429),
    reserveB: data.readBigUInt64LE(437),
    creatorFeesAccrued: data.readBigUInt64LE(469),
  };
}

/**
 * Fee math, verified on 93 historical trades: fee = ceil(amount * ppm / 1e6) and
 * each of the two fee accounts (creator_claim, team_vault) receives floor(fee / 2).
 * Buy: amount = lamports_in; the curve prices lamports_in - fee; the vault is
 *      credited lamports_in - 2*half (an odd lamport stays in the vault).
 * Sell: amount = gross SOL from the curve; the user receives gross - fee.
 */
export function feeSplit(amount: bigint, ppm: number): { fee: bigint; half: bigint; charged: bigint } {
  const p = BigInt(ppm);
  const fee = (amount * p + 999_999n) / 1_000_000n;
  const half = fee / 2n;
  return { fee, half, charged: 2n * half };
}
