#!/usr/bin/env node
/**
 * Tests for the ZCode experience recorder hook (hooks/experience_recorder.mjs).
 * Run: node hooks/tests/test_experience_recorder.mjs
 *
 * Each case spawns the hook with a payload whose cwd points at a temp
 * directory, then asserts on the journal file it wrote. No network, no
 * shared state: every case gets a fresh temp project.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";

const HOOK = new URL("../experience_recorder.mjs", import.meta.url).pathname;
const failures = [];
let checks = 0;

function check(name, actual, expected) {
  checks += 1;
  try {
    assert.deepEqual(actual, expected);
  } catch (err) {
    failures.push(`${name}: attendu ${JSON.stringify(expected)}, obtenu ${JSON.stringify(actual)}`);
  }
}

function runHook(payload, cwd) {
  const proc = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ cwd, session_id: "sess-test", ...payload }),
    encoding: "utf8",
    timeout: 20000,
  });
  return { code: proc.status, out: proc.stdout, err: proc.stderr };
}

function journalOf(project) {
  const path = join(project, ".opencode-memory", "experience-log.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function withTempProject(fn) {
  const project = mkdtempSync(join(tmpdir(), "exp-recorder-"));
  try {
    fn(project);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
}

// 1. Loud successful command -> success event with normalized cmd + family.
withTempProject((project) => {
  runHook(
    {
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: { command: "cargo test --locked" },
      tool_response: { exitCode: 0, output: "test result: ok" },
    },
    project,
  );
  const events = journalOf(project);
  check("success: one event", events.length, 1);
  check("success: kind", events[0]?.kind, "success");
  check("success: normalized cmd", events[0]?.cmd, "cargo test --locked");
  check("success: family", events[0]?.family, "cargo test");
  check("success: seq", typeof events[0]?.seq, "number");
  check("success: session", events[0]?.session_id, "sess-test");
});

// 2. Loud failed command (exitCode 1) -> failure event with the error line.
withTempProject((project) => {
  runHook(
    {
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: { command: "npm test" },
      tool_response: { exitCode: 1, output: "ok first\nerror: 3 failing tests" },
    },
    project,
  );
  const events = journalOf(project);
  check("failure: kind", events[0]?.kind, "failure");
  check("failure: error line", events[0]?.error, "error: 3 failing tests");
});

// 3. Silent command (echo) -> nothing journaled.
withTempProject((project) => {
  runHook(
    {
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: { command: "echo hello" },
      tool_response: { exitCode: 0 },
    },
    project,
  );
  check("echo: no event", journalOf(project).length, 0);
});

// 4. File tools -> file_edited event.
withTempProject((project) => {
  runHook(
    {
      hook_event_name: "PostToolUse",
      tool_name: "Edit",
      tool_input: { file_path: "/tmp/x/src/a.ts" },
      tool_response: { ok: true },
    },
    project,
  );
  const events = journalOf(project);
  check("edit: kind", events[0]?.kind, "file_edited");
  check("edit: file", events[0]?.file, "/tmp/x/src/a.ts");
});

// 5. Failure marker in text output (no numeric exit) -> failure.
withTempProject((project) => {
  runHook(
    {
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: { command: "make all" },
      tool_response: "build ok\nfatal: missing header",
    },
    project,
  );
  check("text marker: kind", journalOf(project)[0]?.kind, "failure");
});

// 6. Dedup: identical project+cmd+kind within the window is swallowed.
withTempProject((project) => {
  const payload = {
    hook_event_name: "PostToolUse",
    tool_name: "Bash",
    tool_input: { command: "cargo test" },
    tool_response: { exitCode: 0 },
  };
  runHook(payload, project);
  runHook(payload, project);
  check("dedup: single event", journalOf(project).length, 1);
});

// 7. Seq stays monotonic across successive events (fresh process each time).
withTempProject((project) => {
  const base = { hook_event_name: "PostToolUse", tool_name: "Bash", tool_response: { exitCode: 0 } };
  runHook({ ...base, tool_input: { command: "cargo build" } }, project);
  runHook({ ...base, tool_input: { command: "cargo test" } }, project);
  const seqs = journalOf(project).map((e) => e.seq);
  check("seq monotonic", seqs.length === 2 && seqs[1] > seqs[0], true);
});

// 8. PostToolUseFailure on Bash -> failure event, error from the payload.
withTempProject((project) => {
  runHook(
    {
      hook_event_name: "PostToolUseFailure",
      tool_name: "Bash",
      tool_input: { command: "go vet ./..." },
      error: "exit status 2",
    },
    project,
  );
  const events = journalOf(project);
  check("failure event: kind", events[0]?.kind, "failure");
  check("failure event: cmd", events[0]?.cmd, "go vet ./...");
});

// 9. Unparseable stdin -> exit 0, no journal, note on stderr (fail-soft).
withTempProject((project) => {
  const proc = spawnSync(process.execPath, [HOOK], { input: "not json", encoding: "utf8" });
  check("invalid stdin: exit 0", proc.status, 0);
  check("invalid stdin: no journal", existsSync(join(project, ".opencode-memory")), false);
});

// 10. Other tools are ignored (Read payload with tool_input.command-like key).
withTempProject((project) => {
  runHook(
    {
      hook_event_name: "PostToolUse",
      tool_name: "Read",
      tool_input: { file_path: "src/x.ts" },
    },
    project,
  );
  check("read: no event", journalOf(project).length, 0);
});

if (failures.length > 0) {
  console.log("FAILURES:");
  for (const failure of failures) console.log(" -", failure);
  process.exit(1);
}
console.log(`OK — ${checks} checks pass`);
