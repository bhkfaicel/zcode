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
