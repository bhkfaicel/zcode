#!/usr/bin/env python3
"""Tests for the bash-guard hook logic (run: python3 tests/test_bash_guard.py)."""

import json
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from bash_guard import extract_command, is_denied  # noqa: E402

HOOK = str(Path(__file__).resolve().parent.parent / "bash_guard.py")

failures = []


def check(name, actual, expected):
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
check("dd", is_denied("dd if=/dev/zero of=/dev/sda") is not None, True)
check("faux positif: remmina", is_denied("remmina"), None)
check("faux positif: rmdir n'est pas rm mais est bloque", is_denied("rmdir d") is not None, True)

# Payload extraction
check("tool_input.command", extract_command({"tool_input": {"command": "ls"}}), "ls")
check("input.command", extract_command({"input": {"command": "ls"}}), "ls")
check("command plat", extract_command({"command": "ls"}), "ls")
check("chaine brute", extract_command("ls"), "ls")
check("payload vide", extract_command({}), None)

# End-to-end through the real hook process
def run_hook(stdin_text):
    proc = subprocess.run(
        [sys.executable, HOOK], input=stdin_text, capture_output=True, text=True
    )
    return proc.returncode, proc.stdout.strip()


code, out = run_hook(json.dumps({"tool_name": "Bash", "tool_input": {"command": "rm -rf /"}}))
check("hook bloque rm", (code, json.loads(out)["decision"]), (0, "block"))
code, out = run_hook(json.dumps({"tool_input": {"command": "echo ok"}}))
check("hook laisse passer", (code, out), (0, ""))
code, out = run_hook("not json")
check("hook fail-open sur stdin invalide", (code, out), (0, ""))

if failures:
    print("ECHECS:")
    for failure in failures:
        print(" -", failure)
    sys.exit(1)
print(f"OK — 19 tests passent")
