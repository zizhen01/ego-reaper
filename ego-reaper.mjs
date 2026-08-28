#!/usr/bin/env node
// ego-reaper — userland GC for leaked ego-lite agent task spaces.
//
// Why this exists: ego lite (≤0.4.7.3) only reclaims agent task spaces after a
// 12-hour app-side window, with no concurrency cap and no timestamps in
// listTaskSpaces (upstream: citrolabs/ego-lite#270, #173; harness-side fix
// pending in PR #271). A kill-heavy agent workload can pile up dozens of dead
// spaces within hours; every space window is composited by WindowServer even
// offscreen. This script closes them from the outside, on a schedule.
//
// Rules (agent-owned spaces only; "agentDelegatedToUser" and "user" are NEVER
// touched — delegated spaces may be under live human control):
//   1. dead-pid : name embeds a creator pid (…-<pid> or …-<pid>-<n>) and that
//                 pid is dead → close now.
//   2. idle     : recentTabTitles unchanged for ≥ EGO_REAPER_IDLE_S → close.
//                 (Activity is tracked in a local state file; a space seen for
//                 the first time is seeded with "now" and never closed on
//                 sight — same first-sight rule as upstream PR #271.)
//   3. over-cap : more than EGO_REAPER_MAX_SPACES agent spaces remain → close
//                 oldest-by-activity first, skipping live-pid lanes and spaces
//                 seeded this run.
//
// Known false-positive risk: a fixed space name that happens to end in digits
// (e.g. "report-2024") parses as a pid; if that pid is dead the space is
// reaped. Escape hatch: EGO_REAPER_PROTECT regex.
//
// Liveness of pids is judged HERE, in stock Node — never inside ego's embedded
// runtime, where child_process has been observed to return an empty process
// table with exit 0 (silent green; see the 2026-08-28 incident).
//
// Safety posture:
//   - If the ego lite app is not running, exit 0 without touching anything
//     (never cold-start the app; that steals focus, upstream #284).
//   - completeTaskSpace(id, {keep:false}) on a USER-owned space would claim
//     and close it (helpers.ts ownership table) — so ownership is checked
//     both when planning and again inside the close script right before
//     each close.
//   - Every ego-browser invocation has an external hard timeout (the runtime
//     can hang silently forever, upstream #306/#307). A timed-out LIST run
//     aborts the whole cycle; we never act on guessed state.
//
// Usage:
//   node ego-reaper.mjs [--dry-run] [--verbose]
// Config (env):
//   EGO_REAPER_BIN         ego-browser binary   (default ~/.local/bin/ego-browser)
//   EGO_REAPER_IDLE_S      idle threshold sec   (default 7200)
//   EGO_REAPER_MAX_SPACES  agent-space cap      (default 8)
//   EGO_REAPER_TIMEOUT_S   per-invocation kill  (default 90)
//   EGO_REAPER_PROTECT     never-touch name regex (default: none)
//   EGO_REAPER_PID_PATTERN pid-in-name regex    (default: -(\d{2,6})(?:-\d+)?$)
//   EGO_REAPER_STATE_FILE  activity state       (default ~/.local/share/ego-reaper/state.json)
//   EGO_REAPER_LOG_FILE    log path             (default ~/.local/share/ego-reaper/reaper.log)

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
  appendFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";

// ---------- config ----------

const HOME = homedir();
const argv = process.argv.slice(2);
const DRY_RUN = argv.includes("--dry-run") || /^(1|true)$/i.test(process.env.EGO_REAPER_DRY_RUN ?? "");
const VERBOSE = argv.includes("--verbose");

const cfg = {
  bin: process.env.EGO_REAPER_BIN || resolve(HOME, ".local/bin/ego-browser"),
  idleS: envInt("EGO_REAPER_IDLE_S", 7200),
  maxSpaces: envInt("EGO_REAPER_MAX_SPACES", 8),
  timeoutS: envInt("EGO_REAPER_TIMEOUT_S", 90),
  protect: process.env.EGO_REAPER_PROTECT || "",
  pidPattern: process.env.EGO_REAPER_PID_PATTERN || String.raw`-(\d{2,6})(?:-\d+)?$`,
  stateFile: process.env.EGO_REAPER_STATE_FILE || resolve(HOME, ".local/share/ego-reaper/state.json"),
  logFile: process.env.EGO_REAPER_LOG_FILE || resolve(HOME, ".local/share/ego-reaper/reaper.log"),
};

function envInt(key, fallback) {
  const n = Number(process.env[key]);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

// ---------- logging ----------

function log(msg) {
  const line = `${new Date().toISOString()} ${msg}`;
  console.log(line);
  try {
    mkdirSync(dirname(cfg.logFile), { recursive: true });
    try {
      if (statSync(cfg.logFile).size > 1024 * 1024) renameSync(cfg.logFile, cfg.logFile + ".1");
    } catch {}
    appendFileSync(cfg.logFile, line + "\n");
  } catch {}
}
const debug = (msg) => { if (VERBOSE) log(`debug: ${msg}`); };

// ---------- state ----------

function loadState() {
  try {
    const raw = JSON.parse(readFileSync(cfg.stateFile, "utf8"));
    if (raw && raw.version === 1 && raw.spaces && typeof raw.spaces === "object") return raw;
  } catch {}
  return { version: 1, spaces: {} };
}

function saveState(state) {
  mkdirSync(dirname(cfg.stateFile), { recursive: true });
  const tmp = cfg.stateFile + ".tmp";
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, cfg.stateFile);
}

// ---------- helpers ----------

function appRunning() {
  const r = spawnSync("/usr/bin/pgrep", ["-f", "ego lite.app/Contents/MacOS/ego lite"], { encoding: "utf8" });
  return r.status === 0;
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e && e.code === "EPERM"; // exists but not ours → alive
  }
}

function pidFromName(name) {
  try {
    const m = new RegExp(cfg.pidPattern).exec(name);
    if (!m) return null;
    const pid = Number(m[1]);
    return Number.isInteger(pid) && pid >= 2 && pid <= 99998 ? pid : null;
  } catch {
    return null;
  }
}

function titlesHash(titles) {
  return createHash("sha1").update(JSON.stringify(titles ?? [])).digest("hex").slice(0, 12);
}

// Run a script inside `ego-browser nodejs` with a hard external timeout.
// Returns the JSON payload after `sentinel`, or throws.
function runEgo(script, sentinel, timeoutS = cfg.timeoutS) {
  const r = spawnSync(cfg.bin, ["nodejs"], {
    input: script,
    encoding: "utf8",
    timeout: timeoutS * 1000,
    killSignal: "SIGKILL",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (r.error) throw new Error(`ego-browser failed: ${r.error.message}`);
  if (r.signal) throw new Error(`ego-browser killed by ${r.signal} after ${timeoutS}s (runtime hang?)`);
  // The embedded runtime emits console.log on stderr (observed on 0.4.7.3) — scan both streams.
  const line = ((r.stdout || "") + "\n" + (r.stderr || ""))
    .split("\n")
    .find((l) => l.startsWith(sentinel));
  if (!line) {
    throw new Error(
      `no ${sentinel} in ego-browser output (status ${r.status}); stdout head: ${JSON.stringify((r.stdout || "").slice(0, 300))}; stderr head: ${JSON.stringify((r.stderr || "").slice(0, 300))}`,
    );
  }
  return JSON.parse(line.slice(sentinel.length));
}

const LIST_SCRIPT = `
const spaces = await listTaskSpaces()
console.log('SPACES:' + JSON.stringify(spaces.map(s => ({
  id: s.id, name: s.name, ownership: s.ownership, titles: s.recentTabTitles || []
}))))
`;

// Ownership is re-verified per id right before each close: completeTaskSpace
// with {keep:false} would claim-and-close a user-owned space, and ownership
// can change between our LIST pass and this script.
function closeScript(ids) {
  return `
const targets = ${JSON.stringify(ids)}
const results = []
const spaces = await listTaskSpaces()
for (const id of targets) {
  const s = spaces.find(x => x.id === id)
  if (!s) { results.push({ id, skip: 'gone' }); continue }
  if (s.ownership !== 'agent') { results.push({ id, skip: 'ownership=' + s.ownership }); continue }
  try {
    const done = Promise.race([
      completeTaskSpace(s.id, { keep: false }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('close timeout 30s')), 30000)),
    ])
    await done
    results.push({ id, ok: true, name: s.name })
  } catch (e) {
    results.push({ id, error: String(e && e.message || e) })
  }
}
console.log('RESULTS:' + JSON.stringify(results))
`;
}

// ---------- main ----------

function main() {
  if (!existsSync(cfg.bin)) {
    log(`skip: ego-browser binary not found at ${cfg.bin}`);
    return 0;
  }
  if (!appRunning()) {
    debug("ego lite app not running; nothing to reap (and we never cold-start it)");
    return 0;
  }

  let spaces;
  try {
    spaces = runEgo(LIST_SCRIPT, "SPACES:");
  } catch (e) {
    log(`error: list failed — ${e.message}`);
    return 1;
  }
  if (!Array.isArray(spaces)) {
    log(`error: unexpected SPACES payload`);
    return 1;
  }

  const now = Date.now();
  const state = loadState();
  const protect = cfg.protect ? new RegExp(cfg.protect) : null;
  const seededNow = new Set();

  const agents = [];
  for (const s of spaces) {
    if (!s || typeof s.id !== "number") continue;
    if (s.ownership !== "agent") { debug(`skip #${s.id} "${s.name}" ownership=${s.ownership}`); continue; }
    if (protect && protect.test(s.name ?? "")) { debug(`skip #${s.id} "${s.name}" protected`); continue; }
    const key = `${s.id}:${s.name}`;
    const hash = titlesHash(s.titles);
    let rec = state.spaces[key];
    if (!rec) {
      rec = { firstSeen: now, lastChange: now, titlesHash: hash };
      state.spaces[key] = rec;
      seededNow.add(key);
    } else if (rec.titlesHash !== hash) {
      rec.titlesHash = hash;
      rec.lastChange = now;
    }
    const pid = pidFromName(s.name ?? "");
    agents.push({ ...s, key, rec, pid, alive: pid !== null ? pidAlive(pid) : null });
  }

  const targets = [];
  const targeted = new Set();
  for (const a of agents) {
    if (a.pid !== null && a.alive === false) {
      targets.push({ ...a, reason: `dead-pid ${a.pid}` });
      targeted.add(a.key);
      continue;
    }
    const idleMs = now - a.rec.lastChange;
    if (!seededNow.has(a.key) && idleMs >= cfg.idleS * 1000) {
      targets.push({ ...a, reason: `idle ${Math.round(idleMs / 60000)}min` });
      targeted.add(a.key);
    }
  }

  const remaining = agents.filter((a) => !targeted.has(a.key));
  let over = remaining.length - cfg.maxSpaces;
  if (over > 0) {
    const candidates = remaining
      .filter((a) => a.alive !== true && !seededNow.has(a.key))
      .sort((x, y) => x.rec.lastChange - y.rec.lastChange);
    for (const a of candidates) {
      if (over <= 0) break;
      targets.push({ ...a, reason: `over-cap ${remaining.length}/${cfg.maxSpaces}` });
      targeted.add(a.key);
      over--;
    }
  }

  // Prune state for spaces that no longer exist.
  const aliveKeys = new Set(agents.map((a) => a.key));
  for (const key of Object.keys(state.spaces)) {
    if (!aliveKeys.has(key)) delete state.spaces[key];
  }

  if (targets.length === 0) {
    saveState(state);
    debug(`nothing to reap (${agents.length} agent space(s) tracked)`);
    return 0;
  }

  const plan = targets.map((t) => `#${t.id} "${t.name}" — ${t.reason}`);
  if (DRY_RUN) {
    log(`dry-run: would reap ${targets.length}/${agents.length} agent space(s):`);
    for (const p of plan) log(`  ${p}`);
    saveState(state);
    return 0;
  }

  log(`reaping ${targets.length}/${agents.length} agent space(s):`);
  for (const p of plan) log(`  ${p}`);

  // A single close was measured at ~20s on 0.4.7.3, so close in small batches
  // and scale each batch's external timeout with its size; a wedged batch
  // doesn't void the progress of earlier ones.
  const CHUNK = 8;
  let anyError = false;
  for (let i = 0; i < targets.length; i += CHUNK) {
    const chunk = targets.slice(i, i + CHUNK);
    let results;
    try {
      results = runEgo(
        closeScript(chunk.map((t) => t.id)),
        "RESULTS:",
        cfg.timeoutS + 35 * chunk.length,
      );
    } catch (e) {
      log(`error: close batch failed — ${e.message}`);
      anyError = true;
      continue;
    }
    for (const r of results) {
      if (r.ok) {
        log(`  closed #${r.id} "${r.name ?? ""}"`);
        const t = chunk.find((x) => x.id === r.id);
        if (t) delete state.spaces[t.key];
      } else if (r.skip) {
        log(`  skipped #${r.id} (${r.skip})`);
      } else {
        log(`  ERROR #${r.id}: ${r.error}`);
        anyError = true;
      }
    }
  }
  saveState(state);
  return anyError ? 1 : 0;
}

process.exit(main());
