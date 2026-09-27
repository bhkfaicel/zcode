# Changelog

All notable changes to this project will be documented in this file.

The format is inspired by [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to semantic versioning.

## [Unreleased]

### Changed

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
