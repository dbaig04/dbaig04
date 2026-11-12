// Meteora DLMM Swap event (Anchor self-CPI event), used by the validate scripts and tests.
import bs58 from "bs58";

export const SWAP_EVENT = Buffer.from([81, 108, 227, 190, 205, 208, 10, 196]);

export interface DlmmSwapEvent {
  amountIn: bigint;
  amountOut: bigint;
  fee: bigint;
  protocolFee: bigint;
  hostFee: bigint;
  start: number;
  end: number;
  swapForY: boolean;
}

/** First DLMM Swap event among a tx's inner instructions (jsonParsed/json encodings: data is base58). */
export function decodeSwapEvent(innerIxs: any[] | undefined, nth = 0): DlmmSwapEvent | null {
  let k = 0;
  for (const g of innerIxs ?? [])
    for (const ix of g.instructions) {
      let d: Buffer;
      try {
        d = Buffer.from(bs58.decode(ix.data));
      } catch {
        continue;
      }
      if (d.length < 16 + 129) continue;
      if (d.subarray(0, 8).toString("hex") !== "e445a52e51cb9a1d" || !d.subarray(8, 16).equals(SWAP_EVENT)) continue;
      if (k++ !== nth) continue;
      const b = d.subarray(16);
      return {
        start: b.readInt32LE(64),
        end: b.readInt32LE(68),
        amountIn: b.readBigUInt64LE(72),
        amountOut: b.readBigUInt64LE(80),
        swapForY: b[88] !== 0,
        fee: b.readBigUInt64LE(89),
        protocolFee: b.readBigUInt64LE(97),
        hostFee: b.readBigUInt64LE(121),
      };
    }
  return null;
}
