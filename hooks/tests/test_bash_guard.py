#!/usr/bin/env python3
"""Tests for the bash-guard hook logic (run: python3 tests/test_bash_guard.py)."""

import json
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from bash_guard import (  # noqa: E402
    REASON_NO_COMMAND,
    STDERR_BLOCK_ALARM,
    STDERR_NOT_BASH,
    STDERR_UNPARSEABLE,
    extract_command,
    is_denied,
)

HOOK = str(Path(__file__).resolve().parent.parent / "bash_guard.py")

failures = []
executed_checks = 0  # dynamic count so the printed total can never drift


def check(name, actual, expected):
    """Record one executed check and collect failures for the final report."""
    global executed_checks
    executed_checks += 1
    if actual != expected:
        failures.append(f"{name}: attendu {expected!r}, obtenu {actual!r}")


# Pure matching logic
check("rm simple", is_denied("rm file.txt") is not None, True)
check("rm -rf recursif", is_denied("rm -rf /tmp/x") is not None, True)
check("sudo rm", is_denied("sudo rm -rf /") is not None, True)
check("nohup rm", is_denied("nohup rm x") is not None, True)
check("commande inoffensive", is_denied("echo hello"), None)
check("git status", is_denied("git status"), None)
check("ls -la", is_denied("ls -la"), None)
check("rm en milieu de chaine (&&)", is_denied("cd /tmp && rm -rf x") is not None, True)
check("rm en milieu de chaine (;)", is_denied("echo a; rm x") is not None, True)
check("rm en milieu de chaine (||)", is_denied("false || rm -rf y") is not None, True)
check("rm en milieu de chaine (|)", is_denied("echo b | rm -") is not None, True)
check("mkfs.vfat", is_denied("mkfs.vfat /dev/sdz") is not None, True)
# mkfs deny rule: the bare token is a deny-list member and every
# mkfs.<fstype> variant is caught by the prefix rule, on every
# quoting/path candidate form
check("mkfs bare token", is_denied("mkfs /dev/sda") is not None, True)
check("mkfs.ext4 prefix variant", is_denied("mkfs.ext4 /dev/sda") is not None, True)
check("dd", is_denied("dd if=/dev/zero of=/dev/sda") is not None, True)
check("faux positif: remmina", is_denied("remmina"), None)
check("faux positif: rmdir n'est pas rm mais est bloque", is_denied("rmdir d") is not None, True)

# Separator coverage: newline, CR and lone & must split segments too
check("rm after newline", is_denied("echo hello\nrm -rf x") is not None, True)
check("rm after CRLF", is_denied("echo hello\r\nrm -rf x") is not None, True)
check("rm after lone ampersand", is_denied("echo done & rm -rf x") is not None, True)
check("double ampersand still yields rm", is_denied("cd /tmp && rm -rf x"), "rm")

# Quoted separators are still over-split (no quote parsing) but must never
# make a fragment whose first token matches a deny token
check("quoted ampersand passes", is_denied('echo "a & b"'), None)
check("quoted semicolon passes", is_denied('echo "x; y"'), None)
check("quoted pipe passes", is_denied('grep "foo|bar" f'), None)
check("quoted double ampersand passes", is_denied('git commit -m "fix && polish"'), None)

# Executable-candidate resolution: path prefixes, quoting contexts and
# wrapper prefixes must not hide the direct command word
check("absolute path /bin/rm", is_denied("/bin/rm -rf x") is not None, True)
check("relative path ./rm", is_denied("./rm -rf x") is not None, True)
check("path prefix with quoted component", is_denied("/bin/'rm' -rf x") is not None, True)
check("single-quoted rm", is_denied("'rm' -rf x") is not None, True)
check("double-quoted rm", is_denied('"rm" -rf x') is not None, True)
check("ANSI-C quoted rm", is_denied("$'rm' -rf x") is not None, True)
check("empty quote pair inside word", is_denied("r''m -rf x") is not None, True)
check("unquoted backslash escape", is_denied("r\\m -rf x") is not None, True)
check("leading backslash escape", is_denied("\\rm file") is not None, True)
check("sudo with spaced option operand", is_denied("sudo -u root rm -rf x") is not None, True)
check("sudo with long option=value", is_denied("sudo --user=root rm -rf x") is not None, True)
check("env with assignment prefix", is_denied("env FOO=1 rm -rf x") is not None, True)
check("env with unset option", is_denied("env -u FOO rm -rf x") is not None, True)
check("leading assignment", is_denied("FOO=1 rm -rf x") is not None, True)
check("time wrapper", is_denied("time rm -rf x") is not None, True)
check("time keyword -p flag", is_denied("time -p rm -rf x") is not None, True)
check("time -o with file operand", is_denied("time -o /tmp/t.txt rm -rf x") is not None, True)
check("nice with adjustment operand", is_denied("nice -n 5 rm -rf x") is not None, True)
check("stdbuf with stream operand", is_denied("stdbuf -o L rm -rf x") is not None, True)
check("command wrapper with path", is_denied("command /bin/rm -rf x") is not None, True)

# Backslash preservation per quoting context: the shell does NOT run rm
# for these (under Bash 5.3 they name a program literally called r\m),
# so they must stay unnormalized and pass
check("single quotes keep backslash", is_denied("'r\\m' -rf x"), None)
check("double quotes keep backslash", is_denied('"r\\m" -rf x'), None)

# Additional negatives: options and paths of benign commands stay untouched
check("absolute path to benign binary", is_denied("/usr/bin/git status"), None)
check("git config-style option", is_denied("git -c foo=bar status"), None)
check("option-looking argument after benign command", is_denied("echo --user rm"), None)

# Documented accepted limits, pinned as passing today (the guard does not
# resolve parameter expansion or aliases; a real shell lexer would be
# required). If one of these ever fails, the resolution grew past the
# documented limits and the module documentation must be revisited.
check("limit: parameter expansion in arguments", is_denied("echo ${X}rm"), None)
check("limit: alias-style indirection", is_denied("myalias rm -rf x"), None)

# Payload extraction
check("tool_input.command", extract_command({"tool_input": {"command": "ls"}}), "ls")
check("input.command", extract_command({"input": {"command": "ls"}}), "ls")
check("command plat", extract_command({"command": "ls"}), "ls")
check("chaine brute", extract_command("ls"), "ls")
check("payload vide", extract_command({}), None)

# End-to-end through the real hook process: exit code, stdout AND stderr
# are captured so every payload-failure mode can be asserted exactly.
def run_hook(stdin_text):
    proc = subprocess.run(
        [sys.executable, HOOK], input=stdin_text, capture_output=True, text=True
    )
    return proc.returncode, proc.stdout.strip(), proc.stderr.strip()


def block_reason(out):
    """Extract the reason of a block decision, tolerating an empty stdout:
    a regression then surfaces as a recorded failure, not a crash."""
    try:
        return json.loads(out)["reason"]
    except (ValueError, KeyError, TypeError):
        return "<no block JSON>"


# Static head and tail of the pinned unparseable-stdin template (the parser
# detail in between varies with the malformed input).
UNPARSEABLE_PREFIX, UNPARSEABLE_SUFFIX = STDERR_UNPARSEABLE.split("{detail}")


code, out, err = run_hook(json.dumps({"tool_name": "Bash", "tool_input": {"command": "rm -rf /"}}))
check("hook bloque rm", (code, json.loads(out)["decision"], err), (0, "block", ""))
code, out, err = run_hook(json.dumps({"tool_input": {"command": "echo ok"}}))
check("hook laisse passer", (code, out, err), (0, "", ""))
code, out, err = run_hook("not json")
check(
    "hook fail-open sur stdin invalide",
    (code, out, err.startswith(UNPARSEABLE_PREFIX), err.endswith(UNPARSEABLE_SUFFIX), "\n" not in err),
    (0, "", True, True, True),
)

# Payload-failure modes, each asserted on exit code, stdout and stderr.
# Precedence: an explicit tool_name other than Bash decides first; with
# tool_name absent the legacy envelope shapes decide, Bash presumed (the
# hook is registered for matcher "Bash").

# Explicit non-Bash passes with a stderr note, whatever it carries
code, out, err = run_hook(json.dumps({"tool_name": "Read", "tool_input": {"file_path": "x"}}))
check("mode: Read avec tool_input passe avec note", (code, out, err), (0, "", STDERR_NOT_BASH))
code, out, err = run_hook(json.dumps({"tool_name": "Grep"}))
check("mode: autre outil explicite passe avec note", (code, out, err), (0, "", STDERR_NOT_BASH))

# Explicit Bash without a usable command string: block + stderr alarm
code, out, err = run_hook(json.dumps({"tool_name": "Bash", "tool_input": {}}))
check(
    "mode: Bash conteneur vide bloque",
    (code, block_reason(out), err),
    (0, REASON_NO_COMMAND, STDERR_BLOCK_ALARM),
)
code, out, err = run_hook(json.dumps({"tool_name": "Bash", "tool_input": {"command": 123}}))
check(
    "mode: Bash commande non string bloque",
    (code, block_reason(out), err),
    (0, REASON_NO_COMMAND, STDERR_BLOCK_ALARM),
)
code, out, err = run_hook(json.dumps({"tool_name": "Bash"}))
check(
    "mode: Bash sans conteneur bloque",
    (code, block_reason(out), err),
    (0, REASON_NO_COMMAND, STDERR_BLOCK_ALARM),
)

# tool_name absent, command-bearing structure with a string command: checked
code, out, err = run_hook(json.dumps({"tool_input": {"command": "rm -rf x"}}))
check("mode: legacy deny bloque", (code, json.loads(out)["decision"], err), (0, "block", ""))
code, out, err = run_hook(json.dumps({"tool_input": {"command": "echo ok"}}))
check("mode: legacy benign passe en silence", (code, out, err), (0, "", ""))
code, out, err = run_hook(json.dumps({"input": {"command": "echo ok"}}))
check("mode: legacy input conteneur passe en silence", (code, out, err), (0, "", ""))

# tool_name absent, command-bearing structure without a string command:
# malformed Bash payload, block + alarm
code, out, err = run_hook(json.dumps({"tool_input": {"command": 123}}))
check(
    "mode: legacy tool_input malforme bloque",
    (code, block_reason(out), err),
    (0, REASON_NO_COMMAND, STDERR_BLOCK_ALARM),
)
code, out, err = run_hook(json.dumps({"tool_input": {}}))
check(
    "mode: legacy conteneur sans commande bloque",
    (code, block_reason(out), err),
    (0, REASON_NO_COMMAND, STDERR_BLOCK_ALARM),
)

# tool_name absent and no command-bearing structure at all: pass + note
code, out, err = run_hook(json.dumps({"session_id": 1}))
check("mode: payload sans structure de commande passe", (code, out, err), (0, "", STDERR_NOT_BASH))
code, out, err = run_hook(json.dumps(42))
check("mode: JSON scalaire passe avec note", (code, out, err), (0, "", STDERR_NOT_BASH))
code, out, err = run_hook(json.dumps(["x"]))
check("mode: JSON liste passe avec note", (code, out, err), (0, "", STDERR_NOT_BASH))

# Bare JSON string on stdin is treated as the command string, checked
code, out, err = run_hook(json.dumps("echo ok"))
check("mode: chaine brute benigne passe en silence", (code, out, err), (0, "", ""))
code, out, err = run_hook(json.dumps("rm -rf x"))
check("mode: chaine brute deny bloque", (code, json.loads(out)["decision"], err), (0, "block", ""))

# A hostile command string through the block path still yields valid JSON
hostile = 'rm -rf "/x $(whoami)"; `id`\n/bin/rm -rf y'
code, out, err = run_hook(json.dumps({"tool_name": "Bash", "tool_input": {"command": hostile}}))
check("mode: commande hostile rend un JSON valide", (code, json.loads(out)["decision"], err), (0, "block", ""))

if failures:
    print("ECHECS:")
    for failure in failures:
        print(" -", failure)
    sys.exit(1)
print(f"OK — {executed_checks} tests passent")
