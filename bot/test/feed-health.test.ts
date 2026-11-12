import { test } from "node:test";
import assert from "node:assert/strict";
import { FreshnessStats } from "../src/feeds/grpc.js";
import { describeRpc, freshnessLines, rpcInfo } from "../src/research/feed-health.js";

test("rpc info: reports only the host and whether it is the public endpoint; never path or query", () => {
  const priv = rpcInfo({ rpcUrl: "https://pro.example-rpc.net/abc/def?api-key=SECRET" }, { RPC_URL: "x" } as NodeJS.ProcessEnv);
  assert.deepEqual(priv, { host: "pro.example-rpc.net", isPublic: false, source: "env" });
  const d = describeRpc(priv);
  assert.ok(!d.includes("SECRET") && !d.includes("abc") && d.includes("pro.example-rpc.net"));
  const pub = rpcInfo({ rpcUrl: "https://api.mainnet-beta.solana.com" }, {} as NodeJS.ProcessEnv);
  assert.equal(pub.isPublic, true);
  assert.match(describeRpc(pub), /PUBLIC RPC fallback.*RPC_URL not set/);
});

test("freshness: slot lag behind tip, time since slot announcement, and shred lead are computed per update", () => {
  const f = new FreshnessStats();
  f.onSlot(100, 1_000);
  f.onSlot(101, 1_400);
  f.onAccount("pool", 100, 101, 1_450); // 1 slot behind tip, 450 ms after slot 100 was announced
  f.onAccount("pool", 101, 101, 1_420); // at tip, 20 ms after announcement
  f.onAccount("pool", 99, 101, 1_500);  // slot never announced -> no "since announced" sample
  assert.equal(f.accountMsgs, 3);
  assert.deepEqual(f.samples.map((s) => s[2]), [1, 0, 2]);
  assert.deepEqual(f.samples.map((s) => s[3]), [450, 20, -1]);
  const grpc = { commitment: "processed", freshness: f } as never;
  const shreds = { slotFirstShredAt: new Map([[100, 900], [101, 1_390]]) } as never;
  const md = freshnessLines(grpc, shreds).join("\n");
  assert.match(md, /commitment: \*\*processed\*\*/);
  // shred lead samples: 1450-900=550, 1420-1390=30 (slot 99 has no shred timestamp)
  assert.match(md, /shred lead: first UDP shred of the slot -> gRPC account update \| 2 \|/);
});
