#!/usr/bin/env python3
"""Bash guard hook for ZCode (PreToolUse, matcher "Bash").

Reproduces the opencode bash permission deny-list: destructive commands
(rm and friends) are blocked before execution, everything else passes.

Protocol (ZCode hooks):
- stdin: JSON hook payload; the Bash command is located tolerantly
  (tool_input.command, input.command, command, or a raw string).
- Classification precedence: an explicit tool_name other than "Bash"
  passes with a stderr note, whatever containers it carries; an explicit
  tool_name "Bash" is a Bash payload; when tool_name is absent the
  payload is presumptively a Bash call (the hook is registered for
  matcher "Bash") and the legacy envelope shapes decide: a command-
  bearing structure with a usable string command is checked, a
  command-bearing structure without one is blocked, anything else
  passes with a stderr note.
- stdout on deny block: {"decision": "block", "reason": "..."} (exit 0).
  A Bash payload whose command is missing or not a string is blocked too
  (block JSON on stdout, alarm on stderr): failing open there would
  silently disarm the guard for exactly the call class it gates.
- stdout on a passing Bash command: nothing, exit 0.
- Unparseable stdin is unclassifiable: pass (fail-open) with a stderr
  notice so the ZCode hook log shows the anomaly.
- A bare JSON string on stdin is treated as the command string.

Matching is segment-aware: the command is split on &&, ||, ;, |, a lone &
(background separator), newline and carriage return, and every segment is
tested, so `cd /tmp && rm -rf x` is caught too.

For every segment the executable candidate is resolved first: leading
NAME=VALUE assignments and a leading run of supported wrapper commands
(sudo, env, nohup, command, time, nice, setsid, stdbuf) together with
their options are skipped, and the first token that survives is compared
to the deny-list through quoting-context candidates (the raw token, its
basename, and the shell-resolved form of each supported quoting style).
"""

import json
import os
import re
import sys

# Decided payload-failure policy. Classification outcomes returned by
# classify_payload: OUTCOME_BASH carries a command string to check against
# the deny-list; OUTCOME_NON_BASH is not a Bash call (pass with a stderr
# note); OUTCOME_MALFORMED is a Bash-shaped payload without a readable
# command string (block with a stderr alarm).
OUTCOME_BASH = "bash"
OUTCOME_NON_BASH = "non_bash"
OUTCOME_MALFORMED = "malformed"

# Pinned stderr lines: the tests assert these strings and the ZCode hook
# log shows them verbatim on anomalies. The unparseable line is a template;
# the parser detail is interpolated at runtime, the static parts stay
# pinned constants.
STDERR_UNPARSEABLE = "bash-guard: unparseable stdin ({detail}); fail-open pass"
STDERR_NOT_BASH = "bash-guard: not a Bash command; pass"
STDERR_BLOCK_ALARM = "bash-guard: Bash payload without readable command string; blocking"

# Stdout block reason for a Bash payload whose command cannot be read.
REASON_NO_COMMAND = "Bash payload without readable command string; blocking"

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
# Alternation order matters: `&&` and `||` come before the character class
# so the two-character operators win over their single-character forms
# (lone `&` background separator, `|` pipe). `;`, newline and CR are the
# remaining POSIX command separators and end a segment as well.
SEGMENT_SPLIT = re.compile(r"&&|\|\||[;|&\r\n]")

# Supported wrapper commands: when they lead a segment they are skipped so
# the executable candidate behind them is inspected. Selected subset; the
# wrapper-parsing residuals (unknown operand-taking options are missed,
# wrapper-terminating options can conservatively over-block) are documented
# module limits.
WRAPPER_TOKENS = frozenset(
    {"sudo", "env", "nohup", "command", "time", "nice", "setsid", "stdbuf"}
)

# Selected subset of wrapper options that consume a separate operand token:
# when such an option is skipped, the token right after it (the option
# operand) is skipped too. Pinned from the host documentation and
# deliberately NOT exhaustive: platform-dependent sudo options and future
# wrapper options are outside the table. Wrappers absent from this table
# (nohup, command, setsid) take no spaced operand in the supported subset.
WRAPPER_OPERAND_OPTIONS = {
    "sudo": frozenset(
        {
            "-u",
            "-g",
            "-p",
            "-C",
            "-r",
            "-t",
            "--user",
            "--group",
            "--prompt",
            "--close-from",
            "--role",
            "--type",
        }
    ),
    "env": frozenset({"-u", "--unset"}),
    "nice": frozenset({"-n", "--adjustment"}),
    "stdbuf": frozenset({"-o", "-e", "-i", "--output", "--error", "--input"}),
    # The external /usr/bin/time takes -o FILE and -f FORMAT while the
    # shell keyword `time` only takes the operand-less -p; the table
    # covers both frontends.
    "time": frozenset({"-o", "-f", "--output", "--format"}),
}

# Leading NAME=VALUE environment assignment (shell identifier rules: a
# letter or underscore first, then letters, digits or underscores; the
# value part is anything up to the end of the token, possibly empty).
ASSIGNMENT_PREFIX = re.compile(r"[A-Za-z_][A-Za-z0-9_]*=")

# Backslashes a POSIX double-quoted string actually removes: only those
# directly preceding $, backtick, double quote, backslash or newline.
# Every other backslash is literal there ("r\m" names a program r\m, not
# rm, so it must not be normalized to rm).
_DOUBLE_QUOTE_ESCAPABLE = frozenset({"$", "`", '"', "\\", "\n"})


def executable_candidate(tokens):
    """Resolve the executable candidate of one segment from its tokens.

    Inside the leading run the following tokens are skipped: supported
    wrapper commands, NAME=VALUE assignment tokens, and '-'-prefixed flag
    tokens (flags are skipped whether or not a wrapper was seen; a real
    command name starting with a dash is contrived and over-blocking it
    is the documented safe direction). When a flag token exactly matches
    the current wrapper's operand-option table, the token right after it
    (the option operand) is skipped as well. A self-contained
    '--opt=value' flag is skipped as a single token. The first token that
    survives the run is the executable candidate; None is returned when
    every token is consumed by the leading run.
    """
    current_wrapper = None
    i = 0
    while i < len(tokens):
        token = tokens[i]
        if token in WRAPPER_TOKENS:
            current_wrapper = token
            i += 1
            continue
        if ASSIGNMENT_PREFIX.match(token):
            i += 1
            continue
        if token.startswith("-"):
            # An operand-taking option hides one extra token; a flag that
            # is not in the current wrapper's table is skipped alone.
            if token in WRAPPER_OPERAND_OPTIONS.get(current_wrapper, ()):
                i += 2
            else:
                i += 1
            continue
        return token
    return None


def _double_quote_unescape(content):
    """Remove the backslashes a POSIX double-quoted string removes.

    Only a backslash directly preceding $, backtick, double quote,
    backslash or newline is dropped; any other backslash stays, because
    it is not special inside double quotes ("r\m" runs r\m, not rm).
    """
    out = []
    i = 0
    while i < len(content):
        ch = content[i]
        if ch == "\\" and i + 1 < len(content) and content[i + 1] in _DOUBLE_QUOTE_ESCAPABLE:
            i += 1  # drop the backslash, keep the escaped character
            continue
        out.append(ch)
        i += 1
    return "".join(out)


def _resolve_unquoted_word(token):
    """Resolve a word that is not fully quoted, mirroring shell quote
    removal for the supported mixed forms.

    - A quoted section whose content holds no backslash contributes its
      content with the quotes removed (r''m -> rm, /bin/'rm' -> /bin/rm):
      this is how the shell concatenates quoting sections of one word.
    - A quoted section containing a backslash is kept verbatim: backslash
      handling inside quotes is context-sensitive and stripping it could
      over-normalize (r'\m' must stay unnormalized, the shell runs r\m).
    - An unquoted backslash escapes the next character: the backslash is
      removed and the next character kept (r\m -> rm, \rm -> rm).
    - An unpaired quote leaves the word unresolved (None): the shell
      would not execute such a word as written (unterminated quote).
    """
    out = []
    i = 0
    while i < len(token):
        ch = token[i]
        if ch in ("'", '"'):
            end = token.find(ch, i + 1)
            if end == -1:
                return None  # unpaired quote: keep the token unnormalized
            if "\\" in token[i + 1:end]:
                out.append(token[i:end + 1])  # context-sensitive: keep verbatim
            else:
                out.append(token[i + 1:end])
            i = end + 1
        elif ch == "\\":
            if i + 1 < len(token):
                out.append(token[i + 1])  # escaped character, backslash dropped
                i += 2
            else:
                i += 1  # trailing backslash contributes nothing
        else:
            out.append(ch)
            i += 1
    return "".join(out)


def deny_candidates(token):
    """Build the set of deny-comparison candidates for one executable token.

    Quoting rules mirror what the shell actually executes per context
    (GNU Bash 5.3): a fully single-quoted token contributes its literal
    content with backslashes untouched ('r\m' stays r\m); a fully
    double-quoted token contributes its content with the POSIX selective
    backslash removal ("r\m" stays r\m); a $'...' token contributes its
    content only when it holds no backslash ($'rm' -> rm; ANSI-C content
    with escapes stays unnormalized, a documented lexical limit); any
    other token is treated as an unquoted/mixed word. os.path.basename is
    applied to every candidate so path prefixes (/bin/rm, ./rm) and
    path-prefixed quoted components (/bin/'rm') resolve to the bare name.
    """
    candidates = {token}
    if (
        len(token) >= 2
        and token[0] == "'"
        and token[-1] == "'"
        and "'" not in token[1:-1]
    ):
        # Fully single-quoted: literal content, backslashes NOT touched.
        candidates.add(token[1:-1])
    elif len(token) >= 2 and token[0] == '"' and token[-1] == '"':
        # Fully double-quoted: selective POSIX backslash removal.
        candidates.add(_double_quote_unescape(token[1:-1]))
    elif token.startswith("$'") and token.endswith("'") and len(token) > 3:
        # ANSI-C quoting, modeled only without escapes; content holding a
        # backslash stays unnormalized (documented lexical limit).
        content = token[2:-1]
        if "\\" not in content:
            candidates.add(content)
    else:
        resolved = _resolve_unquoted_word(token)
        if resolved is not None:
            candidates.add(resolved)
    # basename of every candidate (the raw token included)
    forms = set()
    for candidate in candidates:
        forms.add(candidate)
        forms.add(os.path.basename(candidate))
    return forms


def is_denied(command: str) -> str | None:
    """Return the offending token when the command must be blocked."""
    for segment in SEGMENT_SPLIT.split(command or ""):
        candidate = executable_candidate(segment.strip().split())
        if candidate is None:
            continue
        for form in sorted(deny_candidates(candidate)):
            if form in DENY_FIRST_TOKENS or form == "mkfs" or form.startswith("mkfs."):
                return form
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


def has_command_structure(payload) -> bool:
    """Return True when the payload carries a command-bearing structure.

    A structure is command-bearing when a tool_input or input container is
    present, or a flat command key is present, whatever its usability.
    With tool_name absent the hook is presumptively a Bash call (it is
    registered for matcher "Bash"), so a payload carrying such a structure
    without a usable command string is a malformed Bash payload rather
    than a non-Bash call.
    """
    if not isinstance(payload, dict):
        return False
    return "tool_input" in payload or "input" in payload or "command" in payload


def classify_payload(payload):
    """Classify a parsed hook payload per the decided precedence.

    Returns a tuple (outcome, command): (OUTCOME_BASH, str) carries the
    command string to check; (OUTCOME_MALFORMED, None) marks a Bash-shaped
    payload without a usable command string (blocked); (OUTCOME_NON_BASH,
    None) marks everything else (passed with a stderr note).

    Precedence: an explicit tool_name other than "Bash" decides first and
    the payload is non-Bash whatever containers it carries; an explicit
    tool_name "Bash" is a Bash payload; when tool_name is absent the
    legacy envelope shapes decide, presumptively Bash. A bare JSON string
    payload is the command string itself.
    """
    # An explicit tool_name wins over any container shape: a Read payload
    # carrying a tool_input container is non-Bash, not Bash.
    if isinstance(payload, dict) and "tool_name" in payload:
        if payload.get("tool_name") != "Bash":
            return OUTCOME_NON_BASH, None
        command = extract_command(payload)
        if command is None:
            return OUTCOME_MALFORMED, None
        return OUTCOME_BASH, command
    # tool_name absent: the legacy envelope shapes decide.
    command = extract_command(payload)
    if command is not None:
        return OUTCOME_BASH, command
    if has_command_structure(payload):
        return OUTCOME_MALFORMED, None
    return OUTCOME_NON_BASH, None


def main() -> int:
    try:
        payload = json.loads(sys.stdin.read() or "{}")
    except json.JSONDecodeError as err:
        # Unparseable stdin is unclassifiable (tool_name cannot even be
        # inspected): fail-open by design, loudly noticed on stderr.
        print(STDERR_UNPARSEABLE.format(detail=err), file=sys.stderr)
        return 0

    outcome, command = classify_payload(payload)

    if outcome == OUTCOME_NON_BASH:
        # Explicit other tool, or no command-bearing structure at all:
        # nothing to gate, pass with a stderr note for the hook log.
        print(STDERR_NOT_BASH, file=sys.stderr)
        return 0

    if outcome == OUTCOME_MALFORMED:
        # Bash-shaped payload whose command is missing or not a string:
        # failing open here would silently disarm the guard for exactly
        # the call class it gates, so block loudly instead.
        print(STDERR_BLOCK_ALARM, file=sys.stderr)
        print(json.dumps({"decision": "block", "reason": REASON_NO_COMMAND}))
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
