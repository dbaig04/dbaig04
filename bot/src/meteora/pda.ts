import { PublicKey } from "@solana/web3.js";
import { DLMM_PROGRAM_ID, POOL_ADDRESS } from "../types.js";

export const PROGRAM = new PublicKey(DLMM_PROGRAM_ID);
export const POOL = new PublicKey(POOL_ADDRESS);
export const MEMO_PROGRAM = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
export const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
export const TOKEN_2022_PROGRAM = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
export const ATA_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
export const SYSVAR_CLOCK = new PublicKey("SysvarC1ock11111111111111111111111111111111");

export const EVENT_AUTHORITY = PublicKey.findProgramAddressSync([Buffer.from("__event_authority")], PROGRAM)[0];

export function binArrayBitmapExtensionPda(lbPair: PublicKey = POOL): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("bitmap"), lbPair.toBuffer()], PROGRAM)[0];
}

// PDA derivation is ~0.1-0.5 ms; cache per (lb_pair, index). Keyed by the PublicKey object first
// (no base58 encoding on the hot path), then by its base58 string.
const binArrayCache = new Map<string, Map<number, PublicKey>>();
const binArrayCacheByObj = new WeakMap<PublicKey, Map<number, PublicKey>>();
export function binArrayPda(index: number, lbPair: PublicKey = POOL): PublicKey {
  let m = binArrayCacheByObj.get(lbPair);
  if (!m) {
    const pk = lbPair.toBase58();
    m = binArrayCache.get(pk);
    if (!m) binArrayCache.set(pk, (m = new Map()));
    binArrayCacheByObj.set(lbPair, m);
  }
  const c = m.get(index);
  if (c) return c;
  const b = Buffer.alloc(8);
  b.writeBigInt64LE(BigInt(index));
  const k = PublicKey.findProgramAddressSync([Buffer.from("bin_array"), lbPair.toBuffer(), b], PROGRAM)[0];
  m.set(index, k);
  return k;
}

export function ata(owner: PublicKey, mint: PublicKey, tokenProgram: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([owner.toBuffer(), tokenProgram.toBuffer(), mint.toBuffer()], ATA_PROGRAM)[0];
}

/** floor(binId / 70) */
export function binIdToBinArrayIndex(binId: number): number {
  return Math.floor(binId / 70);
}
