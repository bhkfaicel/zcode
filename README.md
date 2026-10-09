# ZCode user configuration (`~/.zcode`)

> [!IMPORTANT]
> **The canonical repository for this project lives on Forgejo**: <https://code.bhk-itsolutions.com/faicel/zcode>.
> This GitHub repository is only a mirror and is **not** the primary git remote.

Git-versioned, user-scope configuration for the ZCode agent CLI/desktop app.
This repository is the single source of truth for everything ZCode loads from
the home directory: global coding rules, subagent definitions, orchestration
protocols, hooks, dynamic workflows, and the tracked part of the CLI
configuration. Runtime state (provider store, sessions, caches, memory
database) is deliberately gitignored and never committed.

## Repository layout

| Path                                  | Purpose                                                                                                                                                                                                                                                                                    |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `AGENTS.md`                           | Global instructions loaded by every session: coding rules (English-only artifacts, tests architecture, CHANGELOG policy) and the audit workflow agent routing (orchestrator/implementer guardrails, per-task commits, branch discipline).                                                  |
| `agents/`                             | Subagent definitions: the audit trio (`security-auditor`, `performance-auditor`, `architecture-auditor`), `audit-critic`, `implementer`, `ask`, `experience-analyzer`, and the PCB suite (`pcb-creator`, `pcb-designer`, `pcb-emc-auditor`, `pcb-schematic-auditor`, `pcb-spice-auditor`). |
| `protocols/`                          | `orchestrator.md` (audit loop: plan → critic discussion → user validation → implementer → same-type revalidation, one task at a time on a shared `fix/audit-<slug>` branch) and `pcb-orchestrator.md` (full PCB creation cycle).                                                           |
| `hooks/`                              | `bash_guard.py` (Bash tool guard), `experience_recorder.mjs` (failure/success command journal), `experience_analyze_trigger.mjs` + `experience_analyze_worker.mjs` (Stop hook that auto-runs the experience-analyzer on session idle). Tests live in `hooks/tests/`.                       |
| `workflows/`                          | Dynamic workflows: `audit-analyze.dwf.ts` (three auditors in parallel, each writing a plan file) and `audit-fix.dwf.ts` (serial fix loop).                                                                                                                                                 |
| `cli/config.json`                     | Tracked CLI configuration: failover provider models for the ten role agents, MCP servers (opencode-memory global/project, chrome-devtools, context7), and hook registration.                                                                                                               |
| `cli/plugins/known_marketplaces.json` | Plugin marketplace registry (the only other tracked file under `cli/`).                                                                                                                                                                                                                    |
| `setup-failover.py`                   | One-shot per-machine setup: injects the failover provider (router at `http://127.0.0.1:4490/v1`) into `v2/provider_config.json`, the desktop app's provider store, idempotently.                                                                                                           |
| `CHANGELOG.md`                        | Every change to this repository is recorded here (Keep a Changelog format, `Unreleased` section only).                                                                                                                                                                                     |

## Running the hook tests

Each hook test suite is standalone and needs no network access:

```sh
python3 hooks/tests/test_bash_guard.py
node hooks/tests/test_experience_recorder.mjs
zsh hooks/tests/experience_analyze_trigger.test.sh
```

## Fresh-machine setup

1. Clone this repository to `~/.zcode`.
2. Run `python3 setup-failover.py` once to materialize the failover provider
   in the desktop app's provider store (`v2/provider_config.json`).

## Runtime state (never versioned)

`v2/` (provider store and runtime state), `workspace/`, `plugin-workspace/`,
everything under `cli/` except the two tracked files, `plan/` (validated plan
files stay local), `.opencode-memory/` (persistent memory database and
experience journal), `tmp/`, `graphify-out/` (generated code maps), and
`__pycache__/` are gitignored — see `.gitignore` for the authoritative list.

## Conventions

- All artifacts (code, comments, docs, CHANGELOG, commit messages, agent
  prompts) are written in English; only the conversation with the user is in
  French.
- `CHANGELOG.md` is updated on every change; released versions are immutable.
- Plan files live in `plan/` and are the only artifacts allowed to reference
  task/scenario indices; they never appear in code, docs, or the CHANGELOG.
- Audit/dev workflows commit one task per commit on a dedicated
  `fix/audit-<slug>` branch; merges require explicit user approval and pushes
  are forbidden.
