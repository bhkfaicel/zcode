#!/usr/bin/env python3
"""Bash guard hook for ZCode (PreToolUse, matcher "Bash").

Reproduces the opencode bash permission deny-list: destructive commands
(rm and friends) are blocked before execution, everything else passes.

Protocol (ZCode hooks):
- stdin: JSON hook payload; the Bash command is located tolerantly
  (tool_input.command, input.command, command, or a raw string).
- stdout on block: {"decision": "block", "reason": "..."} (exit 0).
- stdout on pass: nothing, exit 0. Parse failure: pass (fail-open) and
  log to stderr so the ZCode hook log shows the anomaly.

Matching is segment-aware: the command is split on &&, ||, ; and | and
every segment is tested, so `cd /tmp && rm -rf x` is caught too.
"""

import json
import re
import sys

# First token deny-list: any command starting with one of these is blocked.
# Extend this list freely; each entry matches the first word of a segment.
DENY_FIRST_TOKENS = (
    "rm",
    "rmdir",
    "shred",
    "mkfs",
    "dd",
    "truncate",
)

# Split points between shell segments (conservative: no quotes parsing).
SEGMENT_SPLIT = re.compile(r"&&|\|\||;|\|")


def first_token(segment: str) -> str:
    """First word of a segment, with a leading env/sudo wrapper stripped."""
    tokens = segment.strip().split()
    for token in tokens:
        if token in ("sudo", "env", "nohup", "command"):
            continue
        return token
    return ""


def is_denied(command: str) -> str | None:
    """Return the offending token when the command must be blocked."""
    for segment in SEGMENT_SPLIT.split(command or ""):
        token = first_token(segment)
        if token in DENY_FIRST_TOKENS or token == "mkfs" or token.startswith("mkfs."):
            return token or segment.strip()
    return None


def extract_command(payload) -> str | None:
    """Locate the Bash command in a hook payload (tolerant to shapes)."""
    if isinstance(payload, str):
        return payload
    if not isinstance(payload, dict):
        return None
    for container in (payload.get("tool_input"), payload.get("input"), payload):
        if isinstance(container, dict) and isinstance(container.get("command"), str):
            return container["command"]
    return None


def main() -> int:
    try:
        payload = json.loads(sys.stdin.read() or "{}")
    except json.JSONDecodeError as err:
        print(f"bash-guard: unparseable stdin ({err}); failing open", file=sys.stderr)
        return 0

    command = extract_command(payload)
    if command is None:
        print(f"bash-guard: no command found in payload; failing open", file=sys.stderr)
        return 0

    offender = is_denied(command)
    if offender is None:
        return 0

    reason = (
        f"Blocked by bash-guard: '{offender}' is on the deny-list "
        f"(patterns: {', '.join(DENY_FIRST_TOKENS)}). Command was: {command}"
    )
    print(json.dumps({"decision": "block", "reason": reason}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
