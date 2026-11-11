// Addresses, PDA derivations and instruction builders for the RISE native
// mint/redeem program. Every PDA below was derived here and checked against
// the accounts of real Buy/Sell transactions and against the bumps stored in
// the market account (see NOTES.md).
import { PublicKey, TransactionInstruction, SystemProgram } from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { RISE_MINT, RISE_PROGRAM_ID, WSOL_MINT } from "../types.js";

export const PROGRAM_ID = new PublicKey(RISE_PROGRAM_ID);
export const MINT = new PublicKey(RISE_MINT);
export const WSOL = new PublicKey(WSOL_MINT);
export const RENT_SYSVAR = new PublicKey("SysvarRent111111111111111111111111111111111");
export const BPF_UPGRADEABLE_LOADER = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");

export const BUY_DISCRIMINATOR = Buffer.from("66063d1201daebea", "hex");
export const SELL_DISCRIMINATOR = Buffer.from("33e685a4017f83ad", "hex");

const pda = (seeds: (Buffer | Uint8Array)[]) => PublicKey.findProgramAddressSync(seeds, PROGRAM_ID)[0];

export function deriveMarket(mint: PublicKey = MINT): PublicKey {
  return pda([Buffer.from("market"), mint.toBuffer()]);
}

export interface RiseAccounts {
  market: PublicKey;
  vault: PublicKey;
  creatorClaim: PublicKey;
  teamVault: PublicKey;
  reflectionVault: PublicKey;
  eventAuthority: PublicKey;
  programData: PublicKey;
}

export function deriveAccounts(mint: PublicKey = MINT): RiseAccounts {
  const market = deriveMarket(mint);
  return {
    market,
    vault: pda([Buffer.from("vault"), market.toBuffer()]),
    creatorClaim: pda([Buffer.from("creator_claim"), market.toBuffer()]),
    teamVault: pda([Buffer.from("team_vault"), WSOL.toBuffer()]),
    reflectionVault: pda([Buffer.from("reflection_vault"), market.toBuffer()]),
    eventAuthority: pda([Buffer.from("__event_authority")]),
    programData: PublicKey.findProgramAddressSync([PROGRAM_ID.toBuffer()], BPF_UPGRADEABLE_LOADER)[0],
  };
}

/** User's wSOL ATA (classic Token program). */
export function userWsolAta(user: PublicKey): PublicKey {
  return getAssociatedTokenAddressSync(WSOL, user, true, TOKEN_PROGRAM_ID);
}

/** User's RISE ATA (Token-2022). */
export function userRiseAta(user: PublicKey, mint: PublicKey = MINT): PublicKey {
  return getAssociatedTokenAddressSync(mint, user, true, TOKEN_2022_PROGRAM_ID);
}

export function userAtas(user: PublicKey): { wsolAta: PublicKey; riseAta: PublicKey } {
  return { wsolAta: userWsolAta(user), riseAta: userRiseAta(user) };
}

// ATA derivation (findProgramAddressSync) costs ~0.1-0.5 ms; ix building is on the hot path.
const ataCache = new Map<string, { wsol: PublicKey; rise: PublicKey }>();
function cachedAtas(user: PublicKey, mint: PublicKey): { wsol: PublicKey; rise: PublicKey } {
  const k = user.toBase58() + mint.toBase58();
  let a = ataCache.get(k);
  if (!a) {
    a = { wsol: userWsolAta(user), rise: userRiseAta(user, mint) };
    if (ataCache.size > 64) ataCache.clear();
    ataCache.set(k, a);
  }
  return a;
}

function tradeIx(disc: Buffer, user: PublicKey, a: bigint, b: bigint, acc: RiseAccounts, mint: PublicKey): TransactionInstruction {
  const data = Buffer.alloc(24);
  disc.copy(data, 0);
  data.writeBigUInt64LE(a, 8);
  data.writeBigUInt64LE(b, 16);
  const m = (pubkey: PublicKey, isWritable: boolean, isSigner = false) => ({ pubkey, isWritable, isSigner });
  const atas = cachedAtas(user, mint);
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    data,
    keys: [
      m(user, true, true), // 0 buyer/seller
      m(acc.market, true), // 1 market
      m(acc.vault, true), // 2 vault (wSOL, owned by market)
      m(acc.creatorClaim, true), // 3 creator fee account (wSOL, owned by market)
      m(acc.teamVault, true), // 4 team fee account (wSOL, global)
      m(acc.reflectionVault, true), // 5 reflection vault (wSOL, owned by market)
      m(mint, true), // 6 RISE mint (Token-2022)
      m(WSOL, false), // 7 wSOL mint
      m(atas.wsol, true), // 8 user wSOL ATA
      m(atas.rise, true), // 9 user RISE ATA
      m(TOKEN_PROGRAM_ID, false), // 10
      m(TOKEN_2022_PROGRAM_ID, false), // 11
      m(ASSOCIATED_TOKEN_PROGRAM_ID, false), // 12
      m(SystemProgram.programId, false), // 13
      m(acc.eventAuthority, false), // 14 anchor event authority
      m(PROGRAM_ID, false), // 15 program (event CPI)
    ],
  });
}

export function buildBuyIx(user: PublicKey, lamportsIn: bigint, minRiseOut: bigint, acc = deriveAccounts(), mint = MINT): TransactionInstruction {
  return tradeIx(BUY_DISCRIMINATOR, user, lamportsIn, minRiseOut, acc, mint);
}

export function buildSellIx(user: PublicKey, riseIn: bigint, minLamportsOut: bigint, acc = deriveAccounts(), mint = MINT): TransactionInstruction {
  return tradeIx(SELL_DISCRIMINATOR, user, riseIn, minLamportsOut, acc, mint);
}
