// Emergency stop helper.
//   npx tsx src/engine/estop.ts [stop] [reason...]   write the kill file and SIGUSR1 the running bot
//   npx tsx src/engine/estop.ts status                kill file, pid, persisted risk state
//   npx tsx src/engine/estop.ts clear                 remove the kill file (the bot must still be restarted)
//   npx tsx src/engine/estop.ts clear-failures        reset the consecutive-failure streak (bot stopped)
// Paths follow KILL_FILE / RISK_STATE_PATH / PID_FILE (defaults data/STOP, data/risk-state.json, data/bot.pid).
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import type { RiskConfig } from "../config.js";

export function estopPaths(e: NodeJS.ProcessEnv = process.env): Pick<RiskConfig, "killFile" | "statePath" | "pidFile"> {
  return { killFile: e.KILL_FILE || "data/STOP", statePath: e.RISK_STATE_PATH || "data/risk-state.json", pidFile: e.PID_FILE || "data/bot.pid" };
}

function readPid(pidFile: string): number | null {
  if (!existsSync(pidFile)) return null;
  const n = Number(readFileSync(pidFile, "utf8").trim());
  return Number.isInteger(n) && n > 0 ? n : null;
}

export function run(args: string[], e: NodeJS.ProcessEnv = process.env, out: (m: string) => void = console.log): number {
  const p = estopPaths(e);
  const cmd = args[0] ?? "stop";
  if (cmd === "stop" || !["status", "clear", "clear-failures"].includes(cmd)) {
    const reason = (cmd === "stop" ? args.slice(1) : args).join(" ") || "manual estop";
    mkdirSync(dirname(p.killFile), { recursive: true });
    writeFileSync(p.killFile, `${reason} (estop.ts at ${new Date().toISOString()})\n`);
    out(`kill file written: ${p.killFile}`);
    const pid = readPid(p.pidFile);
    // a stale pid file could name an unrelated process: only signal it if it looks like the bot
    let cmdline = "";
    try { cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8"); } catch { /* not linux or gone */ }
    if (pid && cmdline && !cmdline.includes("main.ts")) out(`pid ${pid} is not the bot (${cmdline.replace(/\0/g, " ").slice(0, 80)}); not signalling. The kill file still stops it.`);
    else if (pid) {
      try { process.kill(pid, "SIGUSR1"); out(`SIGUSR1 sent to pid ${pid}`); } catch (err) { out(`could not signal pid ${pid}: ${(err as Error).message} (the kill file still stops it on its next tick)`); }
    } else out(`no pid file at ${p.pidFile}; the kill file stops the bot on its next tick / start`);
    return 0;
  }
  if (cmd === "status") {
    out(`kill file ${p.killFile}: ${existsSync(p.killFile) ? `PRESENT (${readFileSync(p.killFile, "utf8").trim()})` : "absent"}`);
    out(`pid file ${p.pidFile}: ${readPid(p.pidFile) ?? "absent"}`);
    out(`risk state ${p.statePath}: ${existsSync(p.statePath) ? readFileSync(p.statePath, "utf8") : "absent"}`);
    return 0;
  }
  if (cmd === "clear") {
    if (existsSync(p.killFile)) rmSync(p.killFile);
    out(`kill file removed. A running bot stays stopped until it is restarted.`);
    return 0;
  }
  // clear-failures
  if (readPid(p.pidFile)) out(`warning: ${p.pidFile} exists; stop the bot first or it may overwrite this change`);
  if (!existsSync(p.statePath)) { out("no risk state file"); return 0; }
  const st = JSON.parse(readFileSync(p.statePath, "utf8"));
  out(`consecutive failures ${st.consecutiveFailures} -> 0`);
  st.consecutiveFailures = 0;
  writeFileSync(p.statePath, JSON.stringify(st, null, 1));
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(run(process.argv.slice(2)));
