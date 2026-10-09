#!/usr/bin/env node
/**
 * Experience journal recorder for ZCode (PostToolUse / PostToolUseFailure hook).
 *
 * ZCode-side port of the opencode experience-recorder plugin: it journals gate
 * events (loud VCS/build/test commands that succeeded or failed) and
 * edited-file context into the SAME journal format (<project>/.opencode-memory/
 * experience-log.jsonl), reusing the opencode lib so journal shape, dedup,
 * rotation, seq allocation and pairing stay identical across both tools. The
 * experience-analyzer (via /learn) then condenses verified failure ->
 * correction -> success pairs into project memory.
 *
 * Protocol (ZCode hooks): stdin carries the hook payload JSON; this script is
 * best-effort by contract — any error prints a stderr note and exits 0 so the
 * session is never broken by recorder issues.
 *
 * Tolerant payload handling (Claude-compatible shape, unknowns skipped):
 * { hook_event_name, tool_name, tool_input: { command | file_path },
 *   tool_response, session_id, cwd }
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";

// Single source of truth for journal format/pairing: the opencode lib. When
// it is absent (ZCode-only machine without the opencode checkout) the
// recorder degrades to a no-op rather than inventing a divergent format.
const LIB_DIR = join(
  process.env.HOME || "",
  ".config/opencode/plugins/lib",
);

let lib;
let io;
try {
  lib = await import(join(LIB_DIR, "experience-lib.js"));
  io = await import(join(LIB_DIR, "experience-io.js"));
} catch (err) {
  console.error(
    `experience-recorder: opencode lib unavailable (${err?.message ?? err}); skipping journaling`,
  );
  process.exit(0);
}

// Same failure vocabulary as the opencode recorder.
const FAILURE_MARKERS =
  /(failed|failure|fatal:|error\[|error:|panic|exit code|nonzero|not found|no such file|aborted|timed out|conflict)/i;

// ZCode-side loudness superset. The shared lib covers VCS/build/test CLIs
// only; hardware-EDA gate commands (kicad-cli DRC/ERC, the offline skill
// analyzers, pcbnew scripts) are the real gates of PCB projects but are not
// "loud" in the lib's sense. Without this superset a failed EDA gate
// journals a failure event that can never pair with its success (successes
// were dropped), so no failure->correction lesson could ever form.
const ZCODE_LOUD_EXTRA =
  /(kicad-cli|pcbnew|analyze_(pcb|schematic|emc)\.py|cross_analysis\.py|simulate_subcircuits|analyze_thermal|parasitics|gnd_via_grid_scan|check_report_sections|deep_review)/i;

/** Loudness decision for ZCode: lib list + the EDA-gate superset. */
function isLoudZcode(cmd) {
  return lib.isLoudCommand(cmd) || ZCODE_LOUD_EXTRA.test(String(cmd || ""));
}

/** Tolerant failure detection over the ZCode tool response shape. */
function detectFailure(response) {
  if (response == null) return false;
  if (typeof response === "object") {
    for (const key of ["exitCode", "exit", "code"]) {
      const value = response[key];
      if (typeof value === "number") return value !== 0;
    }
    if (typeof response.output === "string") {
      return FAILURE_MARKERS.test(response.output);
    }
  }
  return FAILURE_MARKERS.test(String(response));
}

/** First failure-marker line of an output string (the error journal field). */
function firstErrorLine(output) {
  return String(output || "")
    .split("\n")
    .find((line) => FAILURE_MARKERS.test(line)) || "";
}

/** Locate the Bash command in a tool_input variant, or null. */
function extractCommand(toolInput) {
  if (toolInput && typeof toolInput.command === "string") return toolInput.command;
  return null;
}

/** Locate the edited file path for file tools, or null. */
function extractFile(toolInput) {
  if (!toolInput || typeof toolInput !== "object") return null;
  for (const key of ["file_path", "filePath", "path"]) {
    if (typeof toolInput[key] === "string" && toolInput[key]) return toolInput[key];
  }
  return null;
}

function main() {
  let payload;
  try {
    payload = JSON.parse(readFileSync(0, "utf8") || "{}");
  } catch (err) {
    console.error(`experience-recorder: unparseable stdin (${err?.message ?? err})`);
    return;
  }

  const eventName = String(payload.hook_event_name || payload.event || "PostToolUse");
  const toolName = String(payload.tool_name || "");
  const project = String(payload.cwd || process.cwd());
  const sessionId = String(payload.session_id || payload.sessionId || "zcode-unknown");

  // Journal home: the target project's .opencode-memory directory (same
  // layout as opencode so /learn and the analyzer read one format).
  const dir = join(project, ".opencode-memory");
  const journalPath = join(dir, "experience-log.jsonl");
  const rotatedPath = journalPath.replace(/\.jsonl$/, ".jsonl.1");
  const cursorPath = join(dir, "experience-cursor.json");

  const tag = lib.projectTag(project);
  const journal = io.createJournalWriter(journalPath, io.readEvents(journalPath));
  const cursor = io.loadCursor(cursorPath);

  const isFileEvent = toolName === "Edit" || toolName === "Write" || toolName === "NotebookEdit";
  const isBashEvent = toolName === "Bash";

  let kind = null;
  let extra = { sessionId };
  if (eventName === "PostToolUseFailure") {
    if (!isBashEvent) return;
    kind = "failure";
    const response = payload.tool_response;
    extra.cmd = extractCommand(payload.tool_input) ?? "";
    extra.family = lib.commandFamily(extra.cmd);
    extra.error =
      firstErrorLine(
        (response && typeof response === "object" ? response.output : response) ?? "",
      ) ||
      String(payload.error || payload.message || "tool call failed");
  } else if (eventName === "PostToolUse" && isBashEvent) {
    const cmd = extractCommand(payload.tool_input);
    if (cmd === null || !isLoudZcode(cmd)) return; // silent commands are not gate events
    const response = payload.tool_response;
    let failed;
    if (response && typeof response === "object") {
      failed = detectFailure(response);
    } else {
      failed = FAILURE_MARKERS.test(String(response ?? ""));
    }
    kind = failed ? "failure" : "success";
    extra.cmd = cmd;
    extra.family = lib.commandFamily(cmd);
    extra.error = failed
      ? firstErrorLine(
          response && typeof response.output === "string" ? response.output : String(response ?? ""),
        )
      : "";
  } else if (eventName === "PostToolUse" && isFileEvent) {
    const file = extractFile(payload.tool_input);
    if (!file) return;
    kind = "file_edited";
    extra.file = file.slice(0, 300);
  } else {
    return; // not an event this recorder journals
  }

  // Monotonic seq: cursor + current + rotated journal, then bump past any
  // concurrent writer that landed between our read and our append.
  const rotated = io.readEvents(rotatedPath);
  let seq = lib.nextSeq(cursor, [io.readEvents(journalPath), rotated]);
  for (let tries = 0; tries < 3; tries += 1) {
    const current = io.readEvents(journalPath);
    const maxOnDisk = current.reduce((max, e) => Math.max(max, Number(e?.seq) || 0), 0);
    if (maxOnDisk < seq) break;
    seq = maxOnDisk + 1;
  }

  const event = {
    seq: seq++,
    ts: new Date().toISOString(),
    kind,
    session_id: extra.sessionId,
    project,
    tag,
    ...extra,
    cmd: extra.cmd ? lib.sanitize(lib.normalizeCommand(extra.cmd)).slice(0, 300) : undefined,
    error: extra.error ? lib.sanitize(extra.error).slice(0, 250) : undefined,
  };

  const appended = journal.append(event);
  if (!appended) return; // deduplicated or storage failure: best-effort contract
  console.error(`experience-recorder: journaled ${event.kind} seq=${event.seq}`);
}

try {
  main();
} catch (err) {
  console.error(`experience-recorder: unexpected error (${err?.message ?? err})`);
}
process.exit(0);
