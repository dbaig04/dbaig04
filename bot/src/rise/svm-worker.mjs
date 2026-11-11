// Child process that executes the real RISE program in LiteSVM to produce exact
// quotes. Runs out-of-process because litesvm@0.8.0 can abort the whole process
// (C++ std::bad_alloc) after some program-error simulations; a crash here only
// kills this child, the parent sees EOF and returns null / respawns.
//
// Protocol: newline-delimited JSON over two FIFOs (argv[2] = requests, argv[3] = responses).
//   {op:"program", data:b64}                              -> {ok:true}
//   {op:"state", slot, rent:{lpby,thr,burn}|null, accounts:{addr:{lamports,owner,data(b64),executable}}} -> {ok:true}
//   {op:"quote", kind:"buy"|"sell", amount:"<u64>"}        -> {out:"<u64>"} | {out:null, err}
import fs from "node:fs";
import { LiteSVM, Rent, FailedTransactionMetadata } from "litesvm";
import { Keypair, PublicKey, Transaction, TransactionInstruction, ComputeBudgetProgram, SystemProgram } from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";

const [reqPath, respPath] = process.argv.slice(2);
const reqFd = fs.openSync(reqPath, "r");
const respFd = fs.openSync(respPath, "w");
const reply = (o) => fs.writeSync(respFd, JSON.stringify(o) + "\n");

const PID = new PublicKey("RiseP9yY3UnMxd1df7mgGJiR39frg9QGsr1ro3zxrDq");
const MINT = new PublicKey("EMdcVnAigQDBLFj2KQafvFKeBhMhac7LafZv2LTsrise");
const WSOL = new PublicKey("So11111111111111111111111111111111111111112");
const pda = (s) => PublicKey.findProgramAddressSync(s, PID)[0];
const market = pda([Buffer.from("market"), MINT.toBuffer()]);
const A = {
  market,
  vault: pda([Buffer.from("vault"), market.toBuffer()]),
  creator: pda([Buffer.from("creator_claim"), market.toBuffer()]),
  team: pda([Buffer.from("team_vault"), WSOL.toBuffer()]),
  refl: pda([Buffer.from("reflection_vault"), market.toBuffer()]),
  ev: pda([Buffer.from("__event_authority")]),
};

// Synthetic, generously funded user so quotes never fail for lack of funds.
const user = Keypair.generate().publicKey;
const uw = getAssociatedTokenAddressSync(WSOL, user, false, TOKEN_PROGRAM_ID);
const ur = getAssociatedTokenAddressSync(MINT, user, false, TOKEN_2022_PROGRAM_ID);
const WSOL_BAL = 1_000_000_000_000_000n; // 1e6 SOL
const RISE_BAL = 1_000_000_000_000_000_000n; // far above supply; sells are capped by the parent

function tokenAccount(mint, owner, amount, native, ext) {
  const d = Buffer.alloc(ext ? 170 : 165);
  mint.toBuffer().copy(d, 0);
  owner.toBuffer().copy(d, 32);
  d.writeBigUInt64LE(amount, 64);
  d[108] = 1; // state = Initialized
  if (native !== null) {
    d.writeUInt32LE(1, 109);
    d.writeBigUInt64LE(native, 113);
  }
  if (ext) {
    d[165] = 2; // AccountType::Account
    d.writeUInt16LE(7, 166); // ImmutableOwner, len 0
  }
  return d;
}

let svm = null;
let program = null;
let lastState = null;
// litesvm 0.8.0 can abort (std::bad_alloc) on a call made some time AFTER a failed
// simulation, so after any failure the LiteSVM instance is discarded and rebuilt.
let dirty = false;
let rent = { lpby: 5080n, thr: 1.0, burn: 50 };

function fresh() {
  svm = new LiteSVM().withSigverify(false).withBlockhashCheck(false);
  svm.addProgram(PID, program);
}

function setUser() {
  const rentMin = svm.minimumBalanceForRentExemption(165n);
  svm.setAccount(user, { lamports: 1_000_000_000_000, data: new Uint8Array(), owner: SystemProgram.programId, executable: false, rentEpoch: 0 });
  svm.setAccount(uw, { lamports: Number(WSOL_BAL + rentMin), data: tokenAccount(WSOL, user, WSOL_BAL, rentMin, false), owner: TOKEN_PROGRAM_ID, executable: false, rentEpoch: 0 });
  const r22 = svm.minimumBalanceForRentExemption(170n);
  svm.setAccount(ur, { lamports: Number(r22), data: tokenAccount(MINT, user, RISE_BAL, null, true), owner: TOKEN_2022_PROGRAM_ID, executable: false, rentEpoch: 0 });
}

function ix(kind, amount) {
  const data = Buffer.alloc(24);
  Buffer.from(kind === "buy" ? "66063d1201daebea" : "33e685a4017f83ad", "hex").copy(data, 0);
  data.writeBigUInt64LE(amount, 8);
  const m = (pubkey, isWritable, isSigner = false) => ({ pubkey, isWritable, isSigner });
  return new TransactionInstruction({
    programId: PID,
    data,
    keys: [m(user, true, true), m(A.market, true), m(A.vault, true), m(A.creator, true), m(A.team, true), m(A.refl, true), m(MINT, true), m(WSOL, false), m(uw, true), m(ur, true),
      m(TOKEN_PROGRAM_ID, false), m(TOKEN_2022_PROGRAM_ID, false), m(ASSOCIATED_TOKEN_PROGRAM_ID, false), m(SystemProgram.programId, false), m(A.ev, false), m(PID, false)],
  });
}

function quote(kind, amount) {
  const tx = new Transaction();
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }));
  tx.add(ix(kind, amount));
  tx.recentBlockhash = svm.latestBlockhash();
  tx.feePayer = user;
  // simulateTransaction never commits, so the loaded snapshot is untouched between quotes.
  const r = svm.simulateTransaction(tx);
  if (r instanceof FailedTransactionMetadata) return { out: null, err: String(r.err()) };
  const post = r.postAccounts();
  const amt = (k) => {
    const e = post.find(([p]) => p.equals(k));
    return e ? Buffer.from(e[1].data()).readBigUInt64LE(64) : null;
  };
  const w = amt(uw), t = amt(ur);
  if (w === null || t === null) return { out: null, err: "missing post accounts" };
  const out = kind === "buy" ? t - RISE_BAL : w - WSOL_BAL;
  return { out: out.toString(), cu: Number(r.meta().computeUnitsConsumed()) };
}

function applyState(msg) {
  if (msg.rent) rent = { lpby: BigInt(msg.rent.lpby), thr: msg.rent.thr, burn: msg.rent.burn };
  svm.setRent(new Rent(rent.lpby, rent.thr, rent.burn));
  for (const [addr, a] of Object.entries(msg.accounts)) {
    if (!a) continue;
    svm.setAccount(new PublicKey(addr), { lamports: a.lamports, data: Buffer.from(a.data, "base64"), owner: new PublicKey(a.owner), executable: !!a.executable, rentEpoch: 0 });
  }
  if (msg.slot) svm.warpToSlot(BigInt(msg.slot));
  setUser();
}

function handle(msg) {
  switch (msg.op) {
    case "program":
      program = Buffer.from(msg.data, "base64");
      fresh();
      setUser();
      return { ok: true };
    case "state": {
      if (!svm) return { ok: false, err: "no program" };
      lastState = msg;
      applyState(msg);
      return { ok: true };
    }
    case "quote": {
      if (!svm) return { out: null, err: "no program" };
      if (dirty) {
        fresh();
        setUser();
        if (lastState) applyState(lastState);
        dirty = false;
      }
      const q = quote(msg.kind, BigInt(msg.amount));
      if (q.out === null) dirty = true;
      return q;
    }
    case "ping":
      return { ok: true };
    default:
      return { ok: false, err: "bad op" };
  }
}

let buf = "";
const stream = fs.createReadStream(null, { fd: reqFd, encoding: "utf8", highWaterMark: 1 << 20 });
stream.on("data", (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    let res;
    try {
      res = handle(JSON.parse(line));
    } catch (e) {
      res = { ok: false, out: null, err: String(e && e.message ? e.message : e) };
    }
    reply(res);
  }
});
stream.on("end", () => process.exit(0));
