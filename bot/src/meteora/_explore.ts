import { PublicKey } from "@solana/web3.js";
import { getMultipleAccounts } from "./rpc.js";
import { decodeLbPair, decodeBinArray, decodeClock, decodeMint } from "./layout.js";
import { POOL, binArrayPda, SYSVAR_CLOCK } from "./pda.js";
const s0 = await getMultipleAccounts([POOL, SYSVAR_CLOCK, new PublicKey("EMdcVnAigQDBLFj2KQafvFKeBhMhac7LafZv2LTsrise")]);
const lb = decodeLbPair(s0.infos.get(POOL.toBase58())!.data);
console.log(lb.activeId, lb.v, decodeClock(s0.infos.get(SYSVAR_CLOCK.toBase58())!.data), decodeMint(s0.infos.get("EMdcVnAigQDBLFj2KQafvFKeBhMhac7LafZv2LTsrise")!.data));
const idx: number[] = [];
for (let w = 0; w < 16; w++) for (let b = 0; b < 64; b++) if ((lb.binArrayBitmap[w] >> BigInt(b)) & 1n) idx.push(w * 64 + b - 512);
console.log("arrays", idx);
const keys = idx.map((i) => binArrayPda(i));
const s = await getMultipleAccounts(keys);
for (const i of idx) {
  const k = binArrayPda(i); const a = s.infos.get(k.toBase58());
  if (!a) { console.log(i, "missing"); continue; }
  const ba = decodeBinArray(a.data);
  let x = 0n, y = 0n, lo = 0, nz: string[] = [];
  ba.bins.forEach((b, j) => { x += b.amountX; y += b.amountY; if (b.openOrderAmount || b.processedOrderRemainingAmount) lo++; });
  console.log(i, k.toBase58().slice(0, 6), "v", ba.version, "X", x, "Y", y, "lo bins", lo, a.data.length);
}
