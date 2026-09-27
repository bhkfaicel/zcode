# Changelog

All notable changes to this project will be documented in this file.

The format is inspired by [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to semantic versioning.

## [Unreleased]

### Fixed

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
