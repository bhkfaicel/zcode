#!/bin/zsh
# Integration tests for the experience-analyzer ZCode hook pair:
#   experience_analyze_trigger.mjs (Stop hook, fast path)
#   experience_analyze_worker.mjs  (detached analyzer runner + cursor)
#
# Uses a synthetic project under /tmp with a handcrafted journal (failure ->
# file_edited -> success) and a fake analyzer binary that prints a LEARNED
# block, so no real LLM session is launched. Run: zsh tests/experience_analyze_trigger.test.sh

set -u
TRIGGER="$HOME/.zcode/hooks/experience_analyze_trigger.mjs"
WORKER="$HOME/.zcode/hooks/experience_analyze_worker.mjs"
LIB_DIR="/Users/macbook/.config/opencode/plugins/lib"
PASS=0
FAIL=0

check() { # check <label> <condition-exit-code>
  if [ "$2" -eq 0 ]; then echo "PASS: $1"; PASS=$((PASS+1)); else echo "FAIL: $1"; FAIL=$((FAIL+1)); fi
}

# --- 0. syntax -------------------------------------------------------------
node --check "$TRIGGER" 2>/tmp/hooktest_syntax1.err; check "trigger syntax" $?
node --check "$WORKER" 2>/tmp/hooktest_syntax2.err; check "worker syntax" $?

# --- 1. synthetic project with one verifiable pair -------------------------
T=$(mktemp -d /tmp/hooktest.XXXXXX)
P="$T/project"; mkdir -p "$P/.opencode-memory"
J="$P/.opencode-memory/experience-log.jsonl"
TS1="2026-09-29T09:00:00.000Z"; TS2="2026-09-29T09:01:00.000Z"; TS3="2026-09-29T09:02:00.000Z"
{ printf '{"seq":1,"ts":"%s","kind":"failure","session_id":"s1","project":"%s","cmd":"cargo test","family":"cargo test","error":"3 tests failed"}\n' "$TS1" "$P"
  printf '{"seq":2,"ts":"%s","kind":"file_edited","session_id":"s1","project":"%s","file":"src/lib.rs"}\n' "$TS2" "$P"
  printf '{"seq":3,"ts":"%s","kind":"success","session_id":"s1","project":"%s","cmd":"cargo test","family":"cargo test"}\n' "$TS3" "$P"
} > "$J"

# --- 2. DRYRUN: gates pass, decision is would-analyze ----------------------
OUT=$(printf '{"hook_event_name":"Stop","cwd":"%s"}' "$P" | \
  EXPERIENCE_ANALYZE_DRYRUN=1 node "$TRIGGER" 2>&1)
echo "$OUT" | grep -q '"decision":"would-analyze"'; check "dryrun decides would-analyze" $?
echo "$OUT" | grep -q '"pairs_new":1'; check "dryrun sees the 1 new pair" $?
echo "$OUT" | grep -q '"lastSeq":3'; check "dryrun covers seq up to 3" $?
[ ! -f "$P/.opencode-memory/experience-analyze.lock" ]; check "dryrun leaves no lock" $?

# --- 3. full mechanics with a fake analyzer that prints LEARNED ------------
cat > "$T/fake-analyzer.sh" <<'EOF'
#!/bin/sh
# Fake analyzer: prints a summary block the lib's extractSummary recognizes.
echo "LEARNED:"
echo "- synthetic lesson from the hook test"
EOF
chmod +x "$T/fake-analyzer.sh"
printf '{"hook_event_name":"Stop","cwd":"%s"}' "$P" | \
  EXPERIENCE_ANALYZER_BIN="$T/fake-analyzer.sh" node "$TRIGGER"
# Wait for the detached worker to finish (cursor file with lastSeq 3).
OK=1
for i in $(seq 1 20); do
  sleep 0.5
  if [ -f "$P/.opencode-memory/experience-cursor.json" ] && \
     grep -q '"lastSeq":3' "$P/.opencode-memory/experience-cursor.json"; then OK=0; break; fi
done
check "worker advances cursor lastSeq to 3" $OK
[ -f "$P/.opencode-memory/experience-analyze-last.txt" ]; check "last-summary file written" $?
grep -q "synthetic lesson" "$P/.opencode-memory/experience-analyze-last.txt" 2>/dev/null; check "summary content captured" $?
[ ! -f "$P/.opencode-memory/experience-analyze.lock" ]; check "lock released after run" $?
grep -q "analyze ok" "$P/.opencode-memory/experience-analyze.log" 2>/dev/null; check "worker logged success" $?
node -e "
const c = require('$P/.opencode-memory/experience-cursor.json');
process.exit(c.lastRunAt && c.runsCount === 1 ? 0 : 1);
"; check "cursor stamps interval/daily counters" $?

# --- 4. interval gate: new pair added, but lastRunAt is fresh -> skip ------
# (FORCE would bypass the gates entirely; the interval gate needs a genuinely
# new pair (seq 5 > cursor 3) so that only the minimum interval blocks.)
printf '{"seq":4,"ts":"%s","kind":"failure","session_id":"s1","project":"%s","cmd":"cargo test","family":"cargo test","error":"1 test failed"}\n' "$TS3" "$P" >> "$J"
printf '{"seq":5,"ts":"%s","kind":"success","session_id":"s1","project":"%s","cmd":"cargo test","family":"cargo test"}\n' "$TS3" "$P" >> "$J"
OUT2=$(printf '{"hook_event_name":"Stop","cwd":"%s"}' "$P" | \
  EXPERIENCE_ANALYZE_DRYRUN=1 node "$TRIGGER" 2>&1)
echo "$OUT2" | grep -q '"decision":"skip"'; check "30-min interval gate skips rerun" $?

# --- 5. no-pair journal: trigger stays idle --------------------------------
P2="$T/empty"; mkdir -p "$P2/.opencode-memory"
printf '{"seq":1,"ts":"%s","kind":"file_edited","session_id":"s","project":"%s","file":"a.txt"}\n' "$TS1" "$P2" \
  > "$P2/.opencode-memory/experience-log.jsonl"
OUT3=$(printf '{"hook_event_name":"Stop","cwd":"%s"}' "$P2" | \
  EXPERIENCE_ANALYZE_DRYRUN=1 node "$TRIGGER" 2>&1)
echo "$OUT3" | grep -q '"decision":"skip"'; check "journal without pairs skips" $?

# --- 6. real project smoke (informational, no launch in DRYRUN) ------------
REAL="$PWD"
OUT4=$(printf '{"hook_event_name":"Stop","cwd":"%s"}' "$REAL" | \
  EXPERIENCE_ANALYZE_DRYRUN=1 node "$TRIGGER" 2>&1)
echo "real-project dryrun: $OUT4"
check "real project dryrun exits cleanly" $?

rm -rf "$T"
echo "-----"
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
