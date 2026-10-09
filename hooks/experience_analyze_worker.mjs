#!/usr/bin/env node
/**
 * Experience-analyzer detached worker for ZCode (spawned by
 * experience_analyze_trigger.mjs on the Stop hook).
 *
 * Runs the experience-analyzer agent headless through the opencode CLI
 * (EXPERIENCE_ANALYZER_BIN, default "opencode"), with the exact prompt the
 * opencode experience-recorder plugin used, then advances the journal cursor
 * only on a successful analysis (same policy as opencode: lastSeq advances
 * only when a LEARNED/NOTHING NEW summary was extracted; lastRunAt always
 * advances so a broken analyzer cannot spawn on every Stop).
 *
 * Every failure path is best-effort: log to
 * <project>/.opencode-memory/experience-analyze.log and exit 0.
 *
 * Env:
 * - EXPERIENCE_ANALYZER_BIN    analyzer CLI (default "opencode")
 * - EXPERIENCE_ANALYZER_MODEL  analyzer model (default: opencode's constant)
 * - EXPERIENCE_ANALYZER_RUN=1  always set by the trigger (self-trigger guard)
 */

import { appendFileSync, existsSync, readFileSync, truncateSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";

// Same shared lib as the recorder: summary extraction, cursor primitives.
const LIB_DIR = "/Users/macbook/.config/opencode/plugins/lib";

// Keep the opencode plugin's constant: the cheap plan model was chosen
// because the free preview model errors in headless runs. Overridable.
const DEFAULT_MODEL = "zai-coding-plan/glm-5.3-flash";
const ANALYZER_TIMEOUT_MS = 10 * 60 * 1000;
const LOCK_HEARTBEAT_MS = 2 * 60 * 1000;
const LOG_MAX_BYTES = 512 * 1024;

const MEM_DIRNAME = ".opencode-memory";
const PAYLOAD_NAME = "experience-payload.json";
const CURSOR_NAME = "experience-cursor.json";
const LOCK_NAME = "experience-analyze.lock";
const LOG_NAME = "experience-analyze.log";
const LAST_NAME = "experience-analyze-last.txt";

function logLine(memDir, line) {
  try {
    const path = join(memDir, LOG_NAME);
    try {
      if (existsSync(path) && readFileSync(path).length > LOG_MAX_BYTES) truncateSync(path, 0);
    } catch {}
    appendFileSync(path, `${new Date().toISOString()} ${line}\n`);
  } catch {}
}

/**
 * Spawn the analyzer headless and resolve with its learning summary, or null
 * on failure/timeout (identical to the opencode plugin's runAnalyzer; stderr
 * is not piped so a chatty child cannot deadlock the pipe buffer).
 */
function runAnalyzer(bin, model, prompt) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(bin, ["run", "--agent", "experience-analyzer", "--model", model, prompt], {
        env: { ...process.env },
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      resolve(null);
      return;
    }
    let out = "";
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch {}
    }, ANALYZER_TIMEOUT_MS);
    child.stdout.on("data", (c) => {
      out += c;
      if (out.length > 1024 * 1024) out = out.slice(-512 * 1024); // bounded
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(code === 0 ? out : null);
    });
  });
}

async function main() {
  const project = String(process.argv[2] || "");
  if (!project || !existsSync(project)) return;

  const lib = await import(join(LIB_DIR, "experience-lib.js"));
  const io = await import(join(LIB_DIR, "experience-io.js"));

  const memDir = join(project, MEM_DIRNAME);
  const payloadPath = join(memDir, PAYLOAD_NAME);
  const cursorPath = join(memDir, CURSOR_NAME);
  const lockPath = join(memDir, LOCK_NAME);

  if (!existsSync(payloadPath)) return;

  // Heartbeat: touch the lock periodically so the shared lib's 10-minute
  // staleness rule never steals it from a live (long) analyzer run.
  const heartbeat = setInterval(() => {
    try {
      if (existsSync(lockPath)) writeFileSync(lockPath, String(Date.now()));
    } catch {}
  }, LOCK_HEARTBEAT_MS);

  let ok = false;
  let summary = null;
  try {
    const analyzerPayload = JSON.parse(readFileSync(payloadPath, "utf8"));
    const prompt =
      `Read ${payloadPath} first. It is an EXPERIENCE PAYLOAD as defined in ` +
      "your instructions. Analyze it. End with your LEARNED or NOTHING NEW block.";

    const bin = process.env.EXPERIENCE_ANALYZER_BIN || "opencode";
    const model = process.env.EXPERIENCE_ANALYZER_MODEL || DEFAULT_MODEL;
    const raw = await runAnalyzer(bin, model, prompt);
    summary = raw ? lib.extractSummary(raw) : null;

    // Cursor policy (opencode-identical): the attempt always stamps
    // lastRunAt (interval gate applies to attempts); lastSeq advances only
    // when a summary was extracted, so failed runs are retried later.
    const cursor = io.loadCursor(cursorPath);
    const lastSeq =
      summary != null
        ? Math.max(Number(analyzerPayload.lastSeq) || 0, Number(cursor.lastSeq) || 0)
        : Number(cursor.lastSeq) || 0;
    io.saveCursor(cursorPath, lib.advanceCursor(cursor, lastSeq, Date.now()));
    ok = summary != null;

    if (summary) {
      try {
        writeFileSync(join(memDir, LAST_NAME), `${new Date().toISOString()}\n${summary}\n`);
      } catch {}
    }
  } catch (e) {
    logLine(memDir, `worker error: ${e?.message || e}`);
  } finally {
    clearInterval(heartbeat);
    try { io.releaseLock(lockPath); } catch {}
  }

  logLine(
    memDir,
    `analyze ${ok ? "ok" : "failed"} project=${project} summary=${summary ? summary.split("\n")[0].slice(0, 160) : "none"}`
  );
}

main().catch(() => {});
