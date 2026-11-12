// Child process that executes a whole transaction in LiteSVM against an account snapshot sent by
// the parent (src/engine/local-sim.ts). Out-of-process so a native abort or a hang only kills this
// child: the parent's per-request deadline rejects the call, SIGKILLs and respawns the worker.
//
// LiteSVM build: `litesvm-local-sim` (= litesvm@1.6.2, aliased dependency), raw-bytes internal API
// (`dist/internal`, identical in 0.8.0 and 1.6.2). NOT the project's litesvm@0.8.0 (used by the RISE
// oracle): 0.8.0 aborts the process (C++ std::bad_alloc) in the first full GC after any successful
// BPF tx that logs — reproduced with LiteSVM's own bundled Memo program — which in a long-running
// worker means a crash every ~15-300 simulations. 1.6.2 does not (2000 sims, full GC every 100).
// LOCAL_SIM_LITESVM=litesvm selects 0.8.0 anyway (diagnostics).
//
// IPC: child_process.fork with serialization "advanced" (Buffers / Uint8Arrays are passed as binary).
//   {id, op:"setup", features:[{id:Uint8Array, slot:string}], programs:[{id:string, loader:string, elf:Uint8Array}], rent:{lpby,thr,burn}}
//       -> {id, ok:true, ms, litesvm:"<version>", programs:[{id, owner, executable}]}
//   {id, op:"sim", tx:Uint8Array, accounts:{addr:{lamports:string, owner:string, data:Uint8Array, executable:bool}|null},
//         clock:{slot, epochStartTimestamp, epoch, leaderScheduleEpoch, unixTimestamp} (decimal strings), watch:[addr]}
//       -> {id, ok:bool, err?:string, logs:string[], cu:number, post:{addr:{data,lamports,owner}}, simUs, applyUs}
//   {id, op:"ping"} -> {id, ok:true, ...counters}
//   {id, op:"sysvars"} -> {id, ok:true, clock:{...}, rent:{...}}   (tests)
//   {id, op:"featureIds"} -> {id, ok:true, ids:[base58]}   (every feature id this LiteSVM build knows)
//   {id, op:"hang"} / {id, op:"crash"} / {id, op:"gc"}  (tests only: containment / GC safety)
// Accounts persist between "sim" messages (the parent only sends what changed); `null` means the
// account does not exist on chain and is removed (0 lamports / empty / system-owned, which is exactly
// how the runtime treats a non-existent account). Simulation never commits.
import { createRequire } from "node:module";
import { PublicKey } from "@solana/web3.js";

const require = createRequire(import.meta.url);
const MOD = process.env.LOCAL_SIM_LITESVM || "litesvm-local-sim";
const { LiteSvm, FeatureSet, Clock, Rent, Account, FailedTransactionMetadata } = require(`${MOD}/dist/internal`);
let LITESVM_VERSION = "?";
try { LITESVM_VERSION = require(`${MOD}/package.json`).version; } catch { /* exports may hide it */ }

const IX_ERR = ["GenericError", "InvalidArgument", "InvalidInstructionData", "InvalidAccountData", "AccountDataTooSmall", "InsufficientFunds", "IncorrectProgramId", "MissingRequiredSignature", "AccountAlreadyInitialized", "UninitializedAccount", "UnbalancedInstruction", "ModifiedProgramId", "ExternalAccountLamportSpend", "ExternalAccountDataModified", "ReadonlyLamportChange", "ReadonlyDataModified", "DuplicateAccountIndex", "ExecutableModified", "RentEpochModified", "NotEnoughAccountKeys", "AccountDataSizeChanged", "AccountNotExecutable", "AccountBorrowFailed", "AccountBorrowOutstanding", "DuplicateAccountOutOfSync", "InvalidError", "ExecutableDataModified", "ExecutableLamportChange", "ExecutableAccountNotRentExempt", "UnsupportedProgramId", "CallDepth", "MissingAccount", "ReentrancyNotAllowed", "MaxSeedLengthExceeded", "InvalidSeeds", "InvalidRealloc", "ComputationalBudgetExceeded", "PrivilegeEscalation", "ProgramEnvironmentSetupFailure", "ProgramFailedToComplete", "ProgramFailedToCompile", "Immutable", "IncorrectAuthority", "AccountNotRentExempt", "InvalidAccountOwner", "ArithmeticOverflow", "UnsupportedSysvar", "IllegalOwner", "MaxAccountsDataAllocationsExceeded", "MaxAccountsExceeded", "MaxInstructionTraceLengthExceeded", "BuiltinProgramsMustConsumeComputeUnits", "BorshIoError"];
const TX_ERR = ["AccountInUse", "AccountLoadedTwice", "AccountNotFound", "ProgramAccountNotFound", "InsufficientFundsForFee", "InvalidAccountForFee", "AlreadyProcessed", "BlockhashNotFound", "CallChainTooDeep", "MissingSignatureForFee", "InvalidAccountIndex", "SignatureFailure", "InvalidProgramForExecution", "SanitizeFailure", "ClusterMaintenance", "AccountBorrowOutstanding", "WouldExceedMaxBlockCostLimit", "UnsupportedVersion", "InvalidWritableAccount", "WouldExceedMaxAccountCostLimit", "WouldExceedAccountDataBlockLimit", "TooManyAccountLocks", "AddressLookupTableNotFound", "InvalidAddressLookupTableOwner", "InvalidAddressLookupTableData", "InvalidAddressLookupTableIndex", "InvalidRentPayingAccount", "WouldExceedMaxVoteCostLimit", "WouldExceedAccountDataTotalLimit", "MaxLoadedAccountsDataSizeExceeded", "ResanitizationNeeded", "InvalidLoadedAccountsDataSizeLimit", "UnbalancedTransaction", "ProgramCacheHitMaxLimit", "CommitCancelled"];

/** Canonical error string, same format as canonicalRpcError() in local-sim.ts (e.g. "InstructionError(2,Custom(6003))"). */
function canonical(e) {
  if (typeof e === "number") return TX_ERR[e] ?? `TransactionError(${e})`;
  if (e && typeof e.err === "function" && typeof e.index === "number") {
    const ie = e.err();
    let s;
    if (typeof ie === "number") s = IX_ERR[ie] ?? `InstructionError#${ie}`;
    else if (ie && typeof ie.code === "number") s = `Custom(${ie.code})`;
    else s = "BorshIoError";
    return `InstructionError(${e.index},${s})`;
  }
  if (e && typeof e.accountIndex === "number") return `InsufficientFundsForRent(${e.accountIndex})`;
  if (e && typeof e.index === "number") return `DuplicateInstruction(${e.index})`;
  return String(e?.toString?.() ?? e);
}

const pk = (s) => new PublicKey(s).toBytes();
const UPGRADEABLE = "BPFLoaderUpgradeab1e11111111111111111111111";
const SYSTEM = pk("11111111111111111111111111111111");
const EMPTY = new Uint8Array(0);

let setup = null; // last setup message (replayed on rebuild)
const accounts = new Map(); // addr -> account record | null (authoritative copy; replayed into every new VM)
let svm = null;
// The active VM is recycled every RECYCLE_SETS setAccount calls (bounds native memory, which grows
// with every setAccount). Building a VM costs ~80 ms (program load + JIT), so a spare VM is kept
// ready: it is swapped in (only the account replay, ~0.1 ms) and a new spare is built in the
// background, one step (<= one program, <= ~35 ms) per event-loop turn.
const RECYCLE_SETS = Number(process.env.LOCAL_SIM_RECYCLE_SETS ?? 4000);
// diagnostics only: also discard the VM after every failing tx (the RISE oracle's policy)
const DISCARD = process.env.LOCAL_SIM_DISCARD_ON_FAILURE === "1";
let dirty = false;
let sets = 0; // setAccount calls on the active VM
let spare = null; // fully built VM without accounts
let building = null; // { v, steps: [...] } spare under construction
let rebuilds = 0;
let swaps = 0;
let sims = 0;

function toAccount(a) {
  if (!a) return new Account(0n, EMPTY, SYSTEM, false, 0n);
  return new Account(BigInt(a.lamports), a.data, pk(a.owner), !!a.executable, 0n);
}

/** VM construction as a list of steps (base runtime, then one program each, then rent). */
function buildSteps() {
  const s = setup;
  const st = { v: null, steps: [] };
  st.steps.push(() => {
    const fs = new FeatureSet();
    for (const f of s.features) fs.activate(f.id, BigInt(f.slot));
    // Minimal VM, then exactly mainnet's feature set, builtins (system, compute budget, loaders...),
    // sysvars and precompiles. No LiteSVM bundled SPL programs: the mainnet binaries are added below.
    const v = LiteSvm.default();
    v.setFeatureSet(fs);
    v.setBuiltins();
    v.setLamports(1_000_000_000_000_000_000n);
    v.setSysvars();
    v.setPrecompiles();
    v.setSigverify(false);
    v.setBlockhashCheck(false);
    v.setLogBytesLimit(100_000n);
    st.v = v;
  });
  for (const p of s.programs) st.steps.push(() => {
    if (p.loader === UPGRADEABLE) st.v.addProgram(pk(p.id), p.elf);
    else st.v.addProgramWithLoader(pk(p.id), p.elf, pk(p.loader));
  });
  st.steps.push(() => st.v.setRent(new Rent(BigInt(s.rent.lpby), s.rent.thr, s.rent.burn)));
  return st;
}

function buildNow() {
  const st = buildSteps();
  for (const f of st.steps) f();
  return st.v;
}

function activate(v) {
  for (const [k, a] of accounts) v.setAccount(pk(k), toAccount(a));
  svm = v;
  sets = accounts.size;
  dirty = false;
}

// spare-build steps run only when no request arrived for IDLE_MS (a request that arrives during a
// step waits for it: <= ~35 ms, visible in the parent's local ms vs the worker's sim µs)
const IDLE_MS = 15;
let lastMsgAt = 0;
let stepTimer = null;
function stepSpare() {
  stepTimer = null;
  if (!setup || spare) return;
  const idle = performance.now() - lastMsgAt;
  if (idle < IDLE_MS) { stepTimer = setTimeout(stepSpare, IDLE_MS - idle + 1); return; }
  if (!building) building = buildSteps();
  const f = building.steps.shift();
  try { f(); } catch { building = null; return; }
  if (building.steps.length === 0) { spare = building.v; building = null; return; }
  stepTimer = setTimeout(stepSpare, 1);
}

function scheduleSpare() {
  if (!spare && !stepTimer) stepTimer = setTimeout(stepSpare, 1);
}

/** Replace the active VM: the spare if ready, else build synchronously. */
function replace() {
  if (spare) { activate(spare); spare = null; swaps++; }
  else { building = null; activate(buildNow()); rebuilds++; }
  // the retired VM's native memory (~50 MB: programs, JIT, accounts) is only released when V8
  // collects its JS wrapper, and V8 does not see that memory: collect explicitly, off the sim path
  if (globalThis.gc) setImmediate(() => globalThis.gc());
  scheduleSpare();
}

function sim(msg) {
  if (!setup) return { ok: false, err: "worker not set up", logs: [], cu: 0 };
  const entries = Object.entries(msg.accounts);
  if (dirty || !svm || sets + entries.length > RECYCLE_SETS) replace();
  const t0 = performance.now();
  for (const [k, a] of entries) {
    accounts.set(k, a);
    svm.setAccount(pk(k), toAccount(a));
    sets++;
  }
  const c = msg.clock;
  svm.setClock(new Clock(BigInt(c.slot), BigInt(c.epochStartTimestamp), BigInt(c.epoch), BigInt(c.leaderScheduleEpoch), BigInt(c.unixTimestamp)));
  const t1 = performance.now();
  const raw = svm.simulateVersionedTransaction(msg.tx);
  const t2 = performance.now();
  sims++;
  const timing = { applyUs: Math.round((t1 - t0) * 1000), simUs: Math.round((t2 - t1) * 1000), rebuilds, swaps };
  if (raw instanceof FailedTransactionMetadata) {
    const meta = raw.meta();
    if (DISCARD) dirty = true;
    return { ok: false, err: canonical(raw.err()), logs: meta.logs(), cu: Number(meta.computeUnitsConsumed()), post: {}, ...timing };
  }
  const meta = raw.meta();
  const post = {};
  const want = new Set(msg.watch);
  for (const aa of raw.postAccounts()) {
    const k = new PublicKey(aa.address).toBase58();
    if (want.has(k)) { const acc = aa.account(); post[k] = { data: Buffer.from(acc.data()), lamports: acc.lamports().toString(), owner: new PublicKey(acc.owner()).toBase58() }; }
  }
  return { ok: true, logs: meta.logs(), cu: Number(meta.computeUnitsConsumed()), post, ...timing };
}

function handle(msg) {
  switch (msg.op) {
    case "setup": {
      const t0 = performance.now();
      setup = msg;
      accounts.clear();
      spare = null;
      building = null;
      activate(buildNow());
      scheduleSpare();
      const programs = msg.programs.map((p) => { const a = svm.getAccount(pk(p.id)); return { id: p.id, owner: a ? new PublicKey(a.owner()).toBase58() : null, executable: !!a?.executable() }; });
      return { ok: true, ms: performance.now() - t0, litesvm: `${MOD}@${LITESVM_VERSION}`, programs };
    }
    case "sim":
      return sim(msg);
    case "ping":
      return { ok: true, rebuilds, swaps, sets, sims, spareReady: !!spare, litesvm: `${MOD}@${LITESVM_VERSION}`, rssMb: Math.round(process.memoryUsage().rss / 1e6) };
    case "sysvars": {
      if (!svm) return { ok: false, err: "no vm" };
      const c = svm.getClock(), r = svm.getRent();
      return { ok: true, clock: { slot: c.slot.toString(), epochStartTimestamp: c.epochStartTimestamp.toString(), epoch: c.epoch.toString(), leaderScheduleEpoch: c.leaderScheduleEpoch.toString(), unixTimestamp: c.unixTimestamp.toString() }, rent: { lpby: r.lamportsPerByteYear.toString(), thr: r.exemptionThreshold, burn: r.burnPercent } };
    }
    case "featureIds": {
      const f = new FeatureSet();
      return { ok: true, ids: [...f.getActiveFeatures(), ...f.getInactiveFeatures()].map((b) => new PublicKey(b).toBase58()), litesvm: `${MOD}@${LITESVM_VERSION}` };
    }
    case "gc":
      if (globalThis.gc) globalThis.gc();
      return { ok: true, gc: !!globalThis.gc };
    case "hang":
      for (;;) { /* tests: a hung worker must be killed by the parent's deadline */ }
    case "crash":
      process.abort(); // tests: same failure mode as a native abort
      return null;
    default:
      return { ok: false, err: `bad op ${msg.op}` };
  }
}

process.on("message", (msg) => {
  lastMsgAt = performance.now();
  let res;
  try {
    res = handle(msg);
  } catch (e) {
    dirty = true;
    res = { ok: false, err: `worker exception: ${String(e?.message ?? e).slice(0, 300)}`, logs: [], cu: 0 };
  }
  process.send({ id: msg.id, ...res });
  // swap in the spare right after a discard / before the recycle limit, off the next sim's clock
  if (setup && msg.op === "sim" && spare && (dirty || sets > RECYCLE_SETS * 0.9)) { try { replace(); } catch { /* next sim retries */ } }
});
process.on("disconnect", () => process.exit(0));
