#!/usr/bin/env node
/**
 * Experience-analyzer auto-trigger for ZCode (Stop hook).
 *
 * ZCode-side port of the opencode experience-recorder "session.idle" flow:
 * when the main agent's turn ends (Stop), check the project experience
 * journal and, when the same gates as opencode hold (new failure->success
 * pairs since the cursor, 30-minute minimum interval, 5-run daily cap),
 * write the analyzer payload and detach the worker that runs the analyzer
 * headless and advances the cursor.
 *
 * Contract: this hook must return in well under its timeout — the analyzer
 * itself runs detached in experience_analyze_worker.mjs (it may take minutes).
 * Every failure path is silent and exits 0 (best-effort, same as the
 * recorder): a hook problem must never break the agent session.
 *
 * Journal/cursor/pairing logic is imported from the opencode experience lib
 * (single source of truth shared with experience_recorder.mjs).
 *
 * Env overrides (all optional):
 * - EXPERIENCE_ANALYZE_DRYRUN=1  print the decision to stderr, launch nothing
 * - EXPERIENCE_ANALYZE_FORCE=1   bypass shouldTrigger (testing only)
 * - EXPERIENCE_ANALYZER_RUN=1    this process belongs to the analyzer chain
 *                                (set on the worker): never self-trigger
 * - EXPERIENCE_ANALYZER_BIN      analyzer CLI (default "opencode")
 * - EXPERIENCE_ANALYZER_MODEL    analyzer model (default: opencode's choice)
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

// Same shared lib as experience_recorder.mjs (journal format, pairing,
// cursor, trigger policy). If it is absent the trigger degrades to a no-op.
const LIB_DIR = "/Users/macbook/.config/opencode/plugins/lib";
const WORKER_PATH = fileURLToPath(new URL("./experience_analyze_worker.mjs", import.meta.url));

const MEM_DIRNAME = ".opencode-memory";
const JOURNAL_NAME = "experience-log.jsonl";
const PAYLOAD_NAME = "experience-payload.json";

// Payload fields beyond the analyzer's own schema. The analyzer reads
// `pairs` and ignores unknown top-level keys; the worker uses `lastSeq`
// (highest journal seq covered by this payload) to advance the cursor
// after a successful analysis.
const ANALYZER_ENV_FLAG = "EXPERIENCE_ANALYZER_RUN";

function readStdinPayload() {
  try {
    const raw = readFileSync(0, "utf8");
    if (!raw.trim()) return {};
    return JSON.parse(raw);
  } catch {
    return {}; // unparseable stdin: nothing sensible to act on
  }
}

async function main() {
  const payload = readStdinPayload();

  // The analyzer chain must never re-trigger itself.
  if (process.env[ANALYZER_ENV_FLAG] === "1") return;

  // ZCode Stop events carry the workspace cwd; fall back to the hook
  // process cwd, then to skipping (no project -> nothing to analyze).
  const project = String(payload.cwd || payload.project || process.cwd() || "");
  if (!project || !existsSync(project)) return;

  const memDir = join(project, MEM_DIRNAME);
  const journalPath = join(memDir, JOURNAL_NAME);
  const rotatedPath = journalPath + ".1";
  const cursorPath = join(memDir, "experience-cursor.json");
  const lockPath = join(memDir, "experience-analyze.lock");
  const payloadPath = join(memDir, PAYLOAD_NAME);

  if (!existsSync(journalPath) && !existsSync(rotatedPath)) return;

  // Shared lib (pairing + trigger policy). Absent lib -> silent no-op.
  const lib = await import(join(LIB_DIR, "experience-lib.js"));
  const io = await import(join(LIB_DIR, "experience-io.js"));

  const events = [...io.readEvents(rotatedPath), ...io.readEvents(journalPath)];
  const cursor = io.loadCursor(cursorPath);
  const pairs = lib.pairEvents(events);

  const force = process.env.EXPERIENCE_ANALYZE_FORCE === "1";
  const dryrun = process.env.EXPERIENCE_ANALYZE_DRYRUN === "1";

  // Trigger policy (opencode-identical): at least one never-analyzed pair,
  // outside the 30-minute minimum interval, under the 5-run daily cap.
  if (!force && !lib.shouldTrigger(cursor, pairs, Date.now())) {
    if (dryrun) {
      console.error(
        JSON.stringify({ decision: "skip", project, pairs: pairs.length, cursor: cursor.lastSeq ?? null })
      );
    }
    return;
  }

  // Payload covers only pairs newer than the cursor (same as opencode).
  const newPairs = pairs.filter((p) => (p.failure?.seq || 0) > (Number(cursor.lastSeq) || 0));
  const coveredSeq = newPairs.length
    ? Math.max(...newPairs.flatMap((p) => [p.failure?.seq || 0, p.success?.seq || 0]))
    : Number(cursor.lastSeq) || 0;

  const analyzerPayload = {
    project,
    tag: lib.projectTag(project),
    lastSeq: coveredSeq,
    pairs: newPairs.map((p) => ({
      failure: { cmd: p.failure.cmd, error: p.failure.error, ts: p.failure.ts },
      success: { cmd: p.success.cmd, ts: p.success.ts },
      files: p.files,
    })),
  };

  if (dryrun) {
    console.error(
      JSON.stringify({
        decision: "would-analyze",
        project,
        pairs_total: pairs.length,
        pairs_new: newPairs.length,
        lastSeq: coveredSeq,
        worker: WORKER_PATH,
      })
    );
    return;
  }

  // Lock before writing the payload so concurrent Stops cannot double-run;
  // the worker releases it (and heartbeats it while the analyzer runs).
  if (!io.acquireLock(lockPath)) return;

  try {
    mkdirSync(memDir, { recursive: true });
    writeFileSync(payloadPath, JSON.stringify(analyzerPayload, null, 2));
  } catch {
    return; // storage failure: best-effort, stay silent
  }

  // Detach the worker: it awaits the analyzer (up to 10 minutes), advances
  // the cursor and releases the lock. The env flag marks the whole chain so
  // no member of it can re-trigger this hook.
  try {
    const child = spawn(process.execPath, [WORKER_PATH, project], {
      detached: true,
      stdio: "ignore",
      env: { ...process.env, [ANALYZER_ENV_FLAG]: "1" },
    });
    child.on("error", () => {
      // Spawn failure: release the lock so a later Stop can retry.
      try { io.releaseLock(lockPath); } catch {}
    });
    child.unref();
  } catch {
    try { io.releaseLock(lockPath); } catch {}
  }
}

main().catch(() => {});
