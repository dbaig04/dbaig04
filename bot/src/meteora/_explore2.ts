import { PublicKey } from "@solana/web3.js";
import { ata, TOKEN_2022_PROGRAM, TOKEN_PROGRAM } from "./pda.js";
import { getMultipleAccounts } from "./rpc.js";
const R = new PublicKey("EMdcVnAigQDBLFj2KQafvFKeBhMhac7LafZv2LTsrise"), W = new PublicKey("So11111111111111111111111111111111111111112");
const owners = ["24Q5e2FRebiFs3iWvN6pZYA4UTGzA3WUsci4ChhgfYEU", "9akRrSgLmVgJayrdYPygwV4U3YXrAMud2fYS98QMjeRR", "72wotPiwDKz1rf3xdf4hVExjfeuGgR4wQGrHpmobJhHC", "8EZWPDvA4YHWmYy6g6qSbf4fGsuzWjbzN7My9Z6VJMQN"].map((s) => new PublicKey(s));
const keys: PublicKey[] = [];
for (const o of owners) keys.push(o, ata(o, R, TOKEN_2022_PROGRAM), ata(o, W, TOKEN_PROGRAM));
const s = await getMultipleAccounts(keys);
for (const k of keys) { const a = s.infos.get(k.toBase58()); console.log(k.toBase58(), a ? `${a.owner.toBase58()} lamports=${a.lamports} len=${a.data.length} ${a.data.length >= 72 ? "amt=" + a.data.readBigUInt64LE(64) : ""}` : "MISSING"); }
