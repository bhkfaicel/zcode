# Changelog

All notable changes to this project will be documented in this file.

The format is inspired by [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to semantic versioning.

## [Unreleased]

### Added

- Experience-analyzer auto-trigger as a ZCode `Stop` hook — the ZCode-side
  port of the opencode experience-recorder's `session.idle` flow, which had
  never been carried over (the analyzer previously only ran manually via
  `/learn`). Two new scripts under `hooks/`:
  `experience_analyze_trigger.mjs` (fast path: reads the Stop payload,
  checks the project journal `.opencode-memory/experience-log.jsonl` with
  the opencode-identical gates — new failure/success pairs since the cursor,
  30-minute minimum interval, 5-run daily cap via the shared
  `~/.config/opencode/plugins/lib/experience-lib.js` — writes the analyzer
  payload and detaches the worker) and `experience_analyze_worker.mjs`
  (detached: runs the `experience-analyzer` agent headless through the
  opencode CLI with the same prompt and cheap-plan model as opencode, with
  a 10-minute timeout and a lock heartbeat, then advances the journal cursor
  only when a `LEARNED`/`NOTHING NEW` summary was extracted, writing the
  summary to `.opencode-memory/experience-analyze-last.txt` and a diagnostic
  line to `.opencode-memory/experience-analyze.log`). Stop hook registered
  in `cli/config.json` (backup kept at `config.json.bak-experience-hook`).
  Env overrides: `EXPERIENCE_ANALYZE_DRYRUN`, `EXPERIENCE_ANALYZE_FORCE`,
  `EXPERIENCE_ANALYZER_BIN`, `EXPERIENCE_ANALYZER_MODEL`,
  `EXPERIENCE_ANALYZER_RUN` (self-trigger guard). Integration tests in
  `hooks/tests/experience_analyze_trigger.test.sh` (15 checks, all passing):
  dry-run decisions, pair coverage, cursor advance on success, interval
  gate, empty-journal skip, lock lifecycle. Known limitation inherited from
  the recorder: journals only capture loud VCS/build/test commands and
  Edit/Write tool events, so projects whose gates run through other CLIs
  (e.g. `kicad-cli`, `pcbnew` python) produce no pairs and stay idle.

- Recorder loudness superset (`hooks/experience_recorder.mjs`): EDA gate
  commands (`kicad-cli`, `pcbnew`, the offline skill analyzers
  `analyze_pcb.py`/`analyze_schematic.py`/`analyze_emc.py`,
  `cross_analysis.py`, `simulate_subcircuits`, `analyze_thermal`,
  parasitics, `gnd_via_grid_scan.py`, `check_report_sections.py`,
  `deep_review`) now count as loud on the ZCode side. Previously a failed
  EDA gate journaled a failure event whose success was dropped (the shared
  lib's loud list covers VCS/build/test only), so failure->correction pairs
  could never form and the experience-analyzer had nothing to condense for
  PCB work. `hooks/tests/test_experience_recorder.mjs` extended with three
  cases (EDA success journaled, failure->success pair formation asserted
  through `pairEvents`, silent-command regression guard): 25 checks pass.

### Changed

- Runbooks (`~/.agents/commands/`, repo #1 commit ada91b8): `/dev`,
  `/kicad-review` and `/pcb-design` aligned with the session-granularity
  rule — every post-fix revalidation now runs as a fresh Agent-tool
  dispatch of the same-type auditor with a self-contained brief (one
  auditor session per revalidation) instead of resuming the analysis
  session via SendMessage; auditor agentIds serve only plan-creation
  critic dialogues and refreshes; `/dev` revalidation rounds gain a max-3
  rejection ceiling. `/audit` and `/pcb-audit` already followed this model.
- Workflow policy (AGENTS.md): session granularity for audit workflows
  refined — plan-creation dialogues stay in one auditor session for the
  whole critic dialogue, relaunches included: after a quota or transient
  interruption the same session is resumed via its existing agent instance,
  never replaced by a fresh one (fresh sessions only for a new plan/scope
  or an unrecoverable instance); the revalidation audits that follow
  development run one session per audit and per task; the implementer
  likewise executes each new task in a fresh session. Documentation only.
- Audit runbook (`~/.agents/commands/audit.md`) rewritten for its analysis
  phase: step 1 now dispatches the three auditor agents directly via the
  Agent tool (`architecture-auditor`, `performance-auditor`,
  `security-auditor`) so their agent definitions apply (pinned model,
  tools, maxTurns, protocol text), instead of launching the saved
  `audit-analyze` workflow whose inline prompts bypassed those definitions
  and silently ran the auditors on the session model. Fallback ladder on
  model concurrency/quota launch errors: serial relaunch (one auditor at a
  time, architecture first), then stop and ask the user in French (enable
  the commented failover line `#model: failover/<type>-auditor$enabled` in
  the agent definitions, or wait and relaunch later). Frontmatter
  description aligned. No other step changed: critic dialogues, per-plan
  user validation, the `audit-fix` workflow, merge gates and hard rules
  are untouched.
- Git hygiene: `cli/` handling in `.gitignore` switched to a whitelist —
  everything under `cli/` is treated as runtime state and ignored, except
  `cli/config.json` and `cli/plugins/known_marketplaces.json` which stay
  versioned. The previous per-subdirectory rules had let 121 subagent
  session files under `cli/agents/` and one cached image under
  `cli/image-cache/` slip into history through a past `git add -A`; those
  files are untracked from the index (kept on disk), so future `git add -A`
  runs can no longer sweep session state into a commit.
- Workflow policy (AGENTS.md): a new rule mandates one fresh session per
  development task — the development of every new task or plan must start in
  a brand-new session instead of being appended to a long-running
  conversation, with the on-disk plan file (`plan/<YYYY-MM-DD>-<type>-plan.md`)
  as the only context carrier between sessions (each new session re-reads the
  plan file, the branch state, and the CHANGELOG from disk). Documentation
  only: no code behavior affected.

- Repository hygiene: the compiled Python bytecode artifact under
  `hooks/__pycache__/` is no longer tracked, and `__pycache__/` was added to
  `.gitignore`. Bytecode caches are regenerated from source on every
  interpreter run, so a tracked copy only added diff noise and stale-artifact
  churn; the local file remains on disk, now ignored. Git-only change: no
  hook behavior is affected.
- `bash-guard` test-suite diagnostics are now written in English: test
  labels, the failure message format (`expected ... got ...` instead of the
  previous French wording), and the final success and failure output. String
  changes only: the executed checks and their expectations are unchanged.
- `bash-guard` deny check simplified: the redundant `mkfs` equality clause was
  removed (the bare `mkfs` token is already a deny-list member) and the
  `mkfs.` prefix rule is stated as applying to every quoting/path candidate
  form. No behavior change: `mkfs /dev/sda` and `mkfs.ext4 /dev/sda` remain
  blocked, and the test suite pins both.
- `bash-guard` module docstring now states the enforced property on its own
  terms (a first-token backstop: the direct command word behind leading
  assignments and a leading run of supported wrapper commands and options is
  checked against the deny-list, deliberately without a shell parser or a
  sandbox) and documents the accepted limits in three groups: indirect
  execution (interpreter wrappers, command substitution and backticks,
  `xargs`, `find -delete`), wrapper-parsing residuals in both directions
  (the per-wrapper operand-option table is a selected subset, so unknown
  operand-taking options are missed while wrapper-terminating options can
  conservatively over-block), and lexical normalization limits
  (`${...}`/`$(...)`-assembled names, aliases, IFS manipulation, mixed
  quoting beyond the supported forms, `$'...'` content with escapes).
  Documentation only: no behavior change.

### Fixed

- `bash-guard` no longer uses PEP 604 union annotations: the two return
  annotations written with the union operator are now `typing.Optional[str]`.
  Annotations are evaluated eagerly at function-definition time, so the
  union-operator form crashed the module import on interpreters predating
  that syntax (the registration invokes a bare `python3`, whose version is
  host-dependent). The module docstring documents the narrowed claim only:
  the module avoids version-sensitive syntax and uses `typing.Optional`,
  and no runtime-verified minimum Python version is claimed. No behavior
  change on the registered interpreter.
- `bash-guard` payload handling now follows a decided failure-mode policy
  instead of silently failing open on every anomaly: an explicit `tool_name`
  other than `Bash` passes with a stderr note, whatever containers it
  carries; a Bash payload whose command is missing or not a string is
  blocked (block JSON on stdout, alarm on stderr) instead of passing
  silently; with `tool_name` absent the legacy envelope shapes decide,
  presuming Bash since the hook is registered for matcher `Bash`;
  unparseable stdin stays fail-open by design with its stderr notice; a
  bare JSON string on stdin is still treated as the command string. The
  stderr strings are pinned as module constants and asserted by the test
  suite, whose process-level helper now captures stderr alongside the exit
  code and stdout.
- `bash-guard` PreToolUse hook now treats newline, carriage return and a lone
  `&` as command separators when splitting a command into segments, so a
  destructive command placed after those separators (for example
  `echo hello\nrm -rf x` or `echo done & rm -rf x`) is blocked the same way
  it is after `;` or `|`; `&&` and `||` are still matched before their
  single-character forms.
- `bash-guard` test suite reports the real number of executed checks, counted
  dynamically, instead of a hardcoded total that had already drifted from the
  actual number of checks in the file.
- `bash-guard` executable-candidate resolution hardened: path-prefixed
  (`/bin/rm`, `./rm`), quoted and escaped command names (`'rm'`, `"rm"`,
  `$'rm'`, `r''m`, `r\m`, `\rm`, `/bin/'rm'`) now resolve to the bare
  command name before the deny-list comparison, following the quoting rules
  the shell applies per context (single-quote literal content, selective
  POSIX double-quote backslash removal, full backslash removal outside
  quotes, quoting sections concatenated); every candidate is also compared
  through its basename. Leading `NAME=VALUE` assignments and a leading run
  of supported wrappers (`sudo`, `env`, `nohup`, `command`, `time`, `nice`,
  `setsid`, `stdbuf`) are skipped together with their options, including
  options that consume a separate operand token (`sudo -u root`,
  `env -u FOO`, `nice -n 5`, `stdbuf -o L`, `time -o FILE`), so the real
  command behind them is inspected.
