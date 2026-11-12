# MAX competitor research (on-chain, read-only)

All numbers are derived from saved `getTransaction` JSON (always with `maxSupportedTransactionVersion: 1`) and
`getSignaturesForAddress` lists, fetched from public RPC on 2026-11-12. Lamports unless noted. Only **landed**
transactions are visible on-chain, so nothing here says anything about submissions that never landed.

Tools: `src/research/collect.ts` (fetch), `analyze.ts` (per-tx decoding), `report.ts` (aggregates below),
`competitors.ts` (MAX round-trip classifier). Reproduce with
`npx tsx src/research/report.ts --wallet-tx … --wallet-sigs … --pool-tx … --pool-sigs … --tips … --json out.json`.

How the analysis decodes each tx:
- **Route.** Every non-wallet owner whose token accounts moved in two or more mints with opposite signs counts as a
  pool leg. The leg's program comes from the AMM inner ix whose first account is that owner.
- **Realized profit.** The wallet's wSOL Δ + native SOL Δ. Fee and tips are included; residual token deltas are listed
  separately.
- **Durable nonce.** The first ix is decoded as System AdvanceNonceAccount (nonce account, authority); the tx's
  `recentBlockhash` field is then the nonce value.
- **Tips.** System transfers from the wallet, outer and inner, are checked against the 8 Jito tip accounts returned by
  `getTipAccounts` at `mainnet.block-engine.jito.wtf`.

## 1. Research wallet `8pY1Au…` (program `DDsnwb…`)

**Sample.**
- The signature list holds the latest 1,000 txs (slots 468,401,472–468,417,675), about **58 min** of activity, roughly
  17 landed txs per minute: 854 succeeded, 146 failed.
- 1,010 txs were decoded: those 1,000 plus 10 older ones from the DLMM-pool sample, slots 468,366,516–468,417,675.
- Every one is a **v1 transaction** with no ComputeBudget ixs. Priority fee and CU limit sit in the v1 `transactionConfig`.

### 1.1 Structure
| top-level layout | txs |
|---|---|
| System AdvanceNonce, DDsnwb, DDsnwb | 901 |
| System AdvanceNonce, DDsnwb, Token, System, DDsnwb | 102 |
| System AdvanceNonce, DDsnwb, System, DDsnwb | 7 |

- **Ix data.** The first DDsnwb ix starts with a tag byte: `02` in 982 txs, `09` in 28.
  - The next u32 equals the tx's own CU limit in **1,005 / 1,010** txs.
  - The remaining bytes look like a route encoding (small account-index pairs). I did not decode them further;
    nothing in the data supported a specific reading.
  - The final DDsnwb ix carries 1 byte of data and is passed one zero-lamport account.
- **The tag-09 / Token+System variant.** A Token ix and then a System Transfer of the same amount: an unwrap followed
  by a SOL payment to a non-wallet address.
  - Amounts are large: median 5.4M, range 0.2M–914M.
  - **All 109 txs with such a transfer failed.** 106 failed with DDsnwb custom error `0x9`, 3 with "program failed to
    complete"; 37 other failures were CU-meter exhaustion.
  - Because the tx reverts, **no transfer was ever paid**; only the fee was.

### 1.2 What it trades
| | txs | wallet realized SOL Δ (sum) |
|---|---|---|
| succeeded and swapped something | 120 | **+5,474,857** (median −20,259; 38 positive) |
| … of which MAX PumpSwap⇄DLMM round trips (all on H6Bcgds) | 5 | **−171,547** (gross wSOL Δ 1,351–64,169; fees 32,592–140,752) |
| … touching MAX in any pool | 31 | – |
| succeeded, swapped nothing | 744 | **−69,493,509** (fees; median fee 43,641) |
| failed (landed) | 146 | **−82,716,164** (7 failures paid 1.2M–22.0M priority each) |
| **net over the sample** | 1,010 | **−146,734,816 (−0.147 SOL)** |

- It is a multi-token bot. Route programs among the swaps: PumpSwap 88 legs, DLMM 84, Meteora DAMM v2 30, unresolved 49.
- 91 of the 120 swapping txs ended with a non-SOL token delta, so their SOL Δ alone does not fully value them.
- **Fees** (median / p95): fee 49,680 / 248,366; priority 44,680 / 243,366.
- **Compute.** CU limit median 250,800, CU consumed median 141,373. No-swap txs still burn a median 127,789 CU, so the
  program does real work before deciding not to swap.
- **Delivery.** No Jito tips, no memos.

### 1.3 Durable nonces
- **Coverage.** 1,010 / 1,010 txs start with AdvanceNonceAccount.
- **Accounts.** 152 nonce accounts, all with the wallet itself as nonce authority. Txs per account: median 3, p95 25,
  max 71.
- **No reuse.** A nonce value never appears twice on the same account (0 cases), as expected: a landed tx advances it.
- **Shared values.** 172 nonce values appear on several accounts. That is consistent with accounts advanced in the same
  slot receiving the same durable-nonce value.

### 1.4 Repeated attempts: identical copies vs variants
- **Identical copies cannot be observed.** An identical message has the same signature and can land only once, so the
  landed data cannot contain identical copies.
- **Same-slot clusters.** 182 slots hold 2–17 of its landed txs (564 txs). Within those clusters:
  - every tx uses a different nonce account (182 / 182 clusters);
  - priority fees differ in 164 / 182 clusters;
  - the zero-lamport marker account differs in 135 / 182 (see 1.5);
  - the route body (ix data after tag and CU field) is identical across the whole cluster in only **16 / 182**
    clusters; the median cluster holds 2 distinct route bodies.
- **Across slots.** 131 route bodies recur 2+ times (722 txs), typically spread over thousands of slots (median 6,790).
  They are the same route re-attempted later, not same-moment copies.
- **Classification.** Mostly **different variants**: different routes, priority fees and marker accounts, each on its
  own nonce account. Near-identical copies (same route body, different nonce / fee / marker) are a minority.

### 1.5 Delivery tags
- **Jito: verified, unused.** 0 transfers to any of the 8 Jito tip accounts.
- **Other SOL recipients: unverified.** The recipients of the (always reverted) tag-09 transfers are **not** Jito tip
  accounts. 40+ distinct addresses, many with vanity prefixes (`noz…`, `ste11…`, `astra…`, `TEMP…`, `NextbLoCk…`).
  I could not verify from public on-chain evidence which service, if any, each belongs to, so none is attributed here.
- **Marker accounts.** Every tx passes one zero-lamport vanity account of the form `xx111…1y`. Prefixes: `he`, `tr`,
  `se`, `sd`; suffixes: `a`, `f`, `n`. The `sd…` markers appear only on failed txs (109 txs, 0 successes); the others
  succeed 93–98% of the time with similar swap rates (11.7–16.4%). What they mean is not knowable from chain data;
  they may be routing/region tags read off-chain, but that is not verified.

### 1.6 Do the no-swap submissions show a benefit?
- **Cost.** In this sample they cost **69.5M lamports** over 58 min (744 txs). Swapping txs returned +5.5M.
- **Swap rate by cluster size.** Slots with more landed copies contain a swap more often: 12.6% with 1 tx, 23.6% with 2,
  24.2% with 3, 60% with 4, 44.8% with 5+. That is expected if the bot fans out more when it believes an opportunity
  exists. It is not evidence that the extra copies *cause* landing.
- **Net per slot** does not improve with cluster size: −77k at size 1, −87k at 2, −226k at 3, +259k at 4 (10 slots),
  −3.37M at 5+.
- **Block order.** In 52 swap clusters with known order, the swapping tx was first in the block 28 times; in 24, a
  no-swap tx of the same wallet executed earlier. The highest-priority tx of the cluster was the one that swapped in
  30 / 53. Priority fee does not reliably decide which variant swaps.
- **Conclusion.** The data does **not** demonstrate a landing-priority benefit from no-swap submissions, and over this
  sample the strategy loses money net. Our engine does not copy it: one simulated-OK tx at a time, floor enforced
  on-chain.

## 2. Every MAX PumpSwap ⇄ DLMM arber seen on the DLMM pools

**Sample.**
- H6Bcgds: the full signature list for 183 min (1,500 txs, slots 468,360,633–468,411,802).
- 5nwdWt and 6PkALv: only their latest 300 signatures, about 0.3 min and 3.5 min of activity. 5nwdWt sees about
  15 txs/s, mostly no-swap txs from many bots, so a full sample is out of reach on public RPC.
- 2,087 pool signatures in total; 73 txs that actually swapped on a MAX DLMM pool.

**Arbs.**
- **35 PumpSwap⇄DLMM MAX round trips** (routes that bought on one pool and sold on the other), all on H6Bcgds and all
  succeeded. The small samples of 5nwdWt and 6PkALv contained none.
- About **8.6 / hour** on H6Bcgds, by **17 distinct payers**. Directions: 19 buyPumpSellDlmm, 16 buyDlmmSellPump.
- **Profit is thin.** Realized net per arb (fees and tips included): min −225,924, p25 −5,019, **median +775**,
  p75 40,484, p95 195,631, max 2,852,249. Sum +3.12M; a single 2.85M multi-hop trade is most of it.
- **Only 3 of 35 cleared our 100,000-lamport net floor.**
- Size (SOL into the buy pool): median 0.0133 SOL, p95 0.173 SOL.
- **Priority fees:** median 500 (most pay 0–1,000), p95 562,316.
- **Jito tips:** 8 / 35 (median 52,665).
- **Durable nonce:** 13 / 35. Multi-hop: 2.
- **Back-run evidence on the DLMM side:** no arb shared its slot with an earlier non-arb DLMM swap; 2 had one within
  the 3 slots before. PumpSwap-side triggers could not be checked: its pool sees thousands of txs per minute.

| payer | arbs | directions | net sum | median net | median SOL in | median prio | Jito | nonce | top-level program |
|---|---|---|---|---|---|---|---|---|---|
| 2QfBNK… | 6 | 5 pump→dlmm / 1 dlmm→pump | −31,338 | −4,807 | 0.00025 | 500 | 0 | 0 | sattCH… |
| 8pY1Au… (research wallet) | 5 | 2 / 3 | −171,547 | −39,186 | 0.0047 | 59,211 | 0 | 5 | DDsnwb… |
| 86tVXk… | 4 | 3 / 1 | +71,296 | +11,447 | 0.0133 | 0 | 2 | 0 | HYKD2v… |
| gednzJ… | 3 | 1 / 2 | +29,061 | +11,604 | 0.0476 | 0 | 2 | 0 | mog8Rv… |
| GTRa8N… | 3 | 1 / 2 | −322,491 | −55,965 | 0.0959 | 0 | 0 | 0 | Forza4… |
| HiMomv… | 2 | 1 / 1 | +274,508 | +195,631 | 0.0938 | 203,336 | 0 | 2 | Arby1H… |
| Gnat7q… | 2 | 1 / 1 | −9,097 | −4,215 | 0.00053 | 1,000 | 0 | 2 | King7k… |
| 10 others | 1 each | | +3,280,982 combined | | | | 4 | 4 | various |

## 3. What this means for our engine
- **Rarely tradeable.** Opportunities between PumpSwap and H6Bcgds that clear a 100k net floor after fees are rare:
  3 in about 3 h of history. H6Bcgds is tiny (~4 SOL TVL, 10% base fee per the venue registry). 5nwdWt and 6PkALv are
  deeper; the second shadow run covers all three routes (`SHADOW.md`).
- **Many competitors.** Most competitors run their own programs, pay little or no priority fee, and many use nonces or
  Jito. With 17 distinct payers in 3 h, competition is crowded relative to the profit available.
