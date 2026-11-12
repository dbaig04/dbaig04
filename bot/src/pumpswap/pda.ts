import { PublicKey } from "@solana/web3.js";
import { PUMPSWAP_PROGRAM_ID } from "../types.js";

export const PUMP_AMM_PROGRAM = new PublicKey(PUMPSWAP_PROGRAM_ID);
/** pump.fun bonding-curve program (owner of the pool-authority PDA that creates canonical pools). */
export const PUMP_PROGRAM = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
export const PUMP_FEE_PROGRAM = new PublicKey("pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ");
export const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
export const TOKEN_2022_PROGRAM = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
export const ATA_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
export const SYSTEM_PROGRAM = new PublicKey("11111111111111111111111111111111");

const pda = (seeds: Buffer[], program: PublicKey) => PublicKey.findProgramAddressSync(seeds, program)[0];

export const GLOBAL_CONFIG = pda([Buffer.from("global_config")], PUMP_AMM_PROGRAM); // ADyA8hde...
export const EVENT_AUTHORITY = pda([Buffer.from("__event_authority")], PUMP_AMM_PROGRAM); // GS4CU59F...
export const FEE_CONFIG = pda([Buffer.from("fee_config"), PUMP_AMM_PROGRAM.toBuffer()], PUMP_FEE_PROGRAM); // 5PHirr8j...

export function userVolumeAccumulatorPda(user: PublicKey): PublicKey {
  return pda([Buffer.from("user_volume_accumulator"), user.toBuffer()], PUMP_AMM_PROGRAM);
}

export function pumpPoolAuthorityPda(baseMint: PublicKey): PublicKey {
  return pda([Buffer.from("pool-authority"), baseMint.toBuffer()], PUMP_PROGRAM);
}

export function canonicalPoolPda(baseMint: PublicKey, quoteMint: PublicKey): PublicKey {
  const idx = Buffer.alloc(2); // index 0
  return pda([Buffer.from("pool"), idx, pumpPoolAuthorityPda(baseMint).toBuffer(), baseMint.toBuffer(), quoteMint.toBuffer()], PUMP_AMM_PROGRAM);
}

export function bondingCurvePda(mint: PublicKey): PublicKey {
  return pda([Buffer.from("bonding-curve"), mint.toBuffer()], PUMP_PROGRAM);
}

export function ata(owner: PublicKey, mint: PublicKey, tokenProgram: PublicKey): PublicKey {
  return pda([owner.toBuffer(), tokenProgram.toBuffer(), mint.toBuffer()], ATA_PROGRAM);
}
