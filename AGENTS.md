# Coding Rules

- All code must be commented.
- Everything must be written in English except the chat discussion with the user: code comments, technical documentation, CHANGELOG, commit messages, command descriptions, agent prompts and descriptions, etc. Only the conversation with the user must be in French.
- All code must be tested before being considered complete.
- Tests must be placed in separate files.
- Tests must follow this architecture, independently of the language: each module has its source file (e.g. `mod.rs`) and a `tests/` directory next to it containing a `mod.rs` (e.g. `src/core/aead/mod.rs` + `src/core/aead/tests/mod.rs`).
- Always run tests, format and lint before declaring a task complete.
- Do not hallucinate or invent things: if something is unclear or missing, ask the user or search the internet.
- Always refer to official documentation when available (online or local).
- For security best practices, refer to reference sites such as:
  - [OWASP Top 10](https://owasp.org/www-project-top-ten/)
  - [OWASP Cheat Sheet Series](https://cheatsheetseries.owasp.org/)
  - [CWE Top 25](https://cwe.mitre.org/top25/)
  - [NIST](https://www.nist.gov/)
- Never write references to plan IDs or issue IDs in code, comments, documentation (README, markdown files), or the CHANGELOG. This explicitly includes plan step indices (task indices like T-01, scenario indices like S-03, or any T-xx/S-xx variant): they must never appear in code, comments, doc, or the CHANGELOG. Only plan files (`plan/*.md`) may reference these indices.
- Never use long horizontal rules (e.g. `---` or `- - -`) in documentation or code comments.
- Communication with the user must be in French.
- Always update CHANGELOG.md after each change.
- Even for an MVP, code must be secure, performant, and follow best practices: both code best practices and architecture best practices. Quality is never sacrificed for speed, even at MVP stage. The security baseline from OWASP, NIST, CWE and the OWASP Cheat Sheet Series still applies to MVP code.
- Persistent memory (reference database): use the `memory_*` tools provided by the `opencode-memory` MCP server. Save a concise fact (file/decision/gotcha) after every validated milestone or discovery using `memory_store`; never store large blobs. Before taking a decision, consult `memory_search` to avoid re-discovering or contradicting past work ("what did I already do here?"). This is a reference DB shared across sessions — keep it short and factual.
- Memory write-role split (prompt policy): dev/orchestrator/implementer store only `fact`/`decision`-type notes; experience lessons (`experience`, `anti_pattern`, `outcome:failure|success` tagged memories) are owned by the `experience-analyzer` agent, which condenses verified failure -> correction -> success pairs from the per-project experience journal (`.opencode-memory/experience-log.jsonl`, recorded by `plugins/experience-recorder.js`). The analyzer runs automatically on session idle or manually via `/learn`; other agents never store experience lessons themselves. Auditors and the critic stay consultation-only (search, never store).

## Production-readiness and review requests

- Treat user requests such as "is this production ready?", "ready for production", "go/no-go", "audit", "review", "security review", "performance review", "architecture review", or equivalent wording as assessment requests, not implementation requests.
- For assessment requests, stay in audit/verdict mode: inspect the repository, run only the checks needed to support the verdict, and return a clear GO/NO-GO answer with verified evidence, critical blockers, risks, and a recommended plan.
- Do not create or resume a development goal, launch `implementer`, edit code, rewrite tests, create branches, or perform implementation work from an assessment request alone.
- Move from assessment to development only after the user explicitly asks to implement or fix the plan (for example: "implement", "fix", "do the development", "apply the plan").
- If the user asks both for readiness and implementation in the same message, first give the readiness verdict and ask one short confirmation question before starting development unless the implementation authorization is explicit and unambiguous.

## Audit workflow agent routing

- Audit workflows (security, performance, or architecture audits, including the `/audit` command) must run in the `orchestrator` agent, which owns the auditor / critic / implementer loop and its guardrails.
- Sole exception: the full-cycle `dev` agent (primary agent, `agent/dev.md`) runs its own plan → user validation → implementation → audit cycle in a single session. It must still respect the same guardrails: explicit user validation of the plan before any edit, dedicated `fix/<slug>` branch, serial fixes revalidated by the same-type auditor, no pushes, merge only after explicit user approval.
- The GLOBAL audit plan (the auditor's plan file) must be presented to the user for explicit validation (path, objective, task list, risks) before any implementer launch or branch creation. Decomposing the validated plan into tasks or mini-tasks afterwards does not require separate user validation.
- If an audit request arrives in the `build` agent, `build` must NOT orchestrate the audit and must NOT edit code itself: it redirects the user to run `/audit` from the `orchestrator` agent instead of taking over.
- If `build` is already inside an active audit loop, it delegates every implementation change to the `implementer` subagent and never writes code itself; if delegation is impossible, it stops and reports instead of continuing solo.
- The same no-solo rule applies to the `orchestrator`: it coordinates only. Empty responses and unavailable Tasks are different failures and must never become a reason to implement, edit project files, or tick plan checkboxes itself.
- Empty response (empty Task result or empty user ask): use EMPTY RESPONSE RECOVERY — up to 20 retries with a 30-second `sleep` between attempts (Task: resume the same `task_id` with "continue"; user ask: re-ask the same question). Do not treat empty as a hard workflow failure until those attempts are exhausted.
- Task unavailable (cancelled, provider error, Task tool dead, required subagent cannot launch): NOT the same as empty. Retry the same Task once; if it still fails, stop and ask the user. Never invent a serial solo-implementation fallback or a goal that says to execute as the orchestrator because subagents are unavailable.
- Subagent quota/context exhaustion (auditor or implementer session): STOP and report which subagent is exhausted and what remains, then wait for the user's explicit renewal signal; never loop waiting for renewal (each orchestrator turn resends the full context and burns tokens). The relaunch is a FRESH session of the SAME agent with a takeover brief that re-reads the plan file from disk and covers only the remaining scope, diff-scoped (`git diff <base>...HEAD`, the directly touched files, and their immediate callers). Never substitute another agent type.
- HUMAN OVERRIDE has highest priority: if the human aborts in the UI, sends an explicit stop/cancel/arrête message, dismisses an ask, or gives a contrary instruction during any recovery or auto-continue, stop immediately, cancel the retry loop, do not re-ask/re-Task/sleep further, and wait for the next human instruction. Human intent outranks empty-response retries.
- Never paste command file contents as chat text: invoke commands with the slash syntax (for example `/audit`) so the frontmatter (agent, model) is parsed and applied.
- Audit analyses may run in parallel: the three auditors' initial analyses AND their full critic discussions of distinct plan files may be launched concurrently (independent auditor/critic task_id pairs, at most one active subagent per plan). Everything else in the fix loop is strictly serial: one subagent at a time, fixed order architecture, then performance, then security; a phase must be fully closed (including the next plan's inter-phase refresh and its critic re-approval) before the next one's development starts.
- Per-task commits are user-mandated in audit/dev workflows: the implementer creates exactly one commit per ACCEPTED task on its dedicated branch (dev does the same in its own cycle; `git add -A` so gitignored plan files stay out of history). This is an explicit exception to "only commit when explicitly requested" for these two agents: never pushes, and merges remain gated by explicit user approval.
- Between phases, the next phase's same-type auditor must re-verify its plan against the changed code (inter-phase refresh) before that phase's critic review and user validation.
- Critic feedback is a discussion, not an order: on CHANGES_REQUIRED the auditor answers `ACCEPTED` (convinced, it updates the plan) or `REBUTTED` (evidence-based justification and/or clarification request), and the critic judges rebuttals on evidence, may ask its own clarification questions, and lifts an objection only when convinced. No agreement after 3 rounds -> user arbitration with both positions summarized.
- Auditor scope discipline: the initial analysis covers the full requested scope (whole repository or the explicitly briefed feature); revalidation of already-ticked tasks is limited to the branch diff (`git diff <base>...HEAD`), the directly touched files, and their immediate callers.
- A new implementer task may start only after the previous task received an ACCEPTED verdict from the same-type auditor (security work by the security auditor, performance by the performance auditor, architecture by the architecture auditor). Auditor substitution is forbidden; if the required auditor is unavailable, stop and report to the user.
- Every development task runs exclusively on a dedicated `fix/audit-<slug>` branch, never on the base branch; each implementer checkpoint states the active branch (`git branch --show-current`). One branch per audit run: all phases share the same branch, whose exact name the orchestrator pins at the first implementer brief (implementers never invent slugs). Merges happen only after full validation AND explicit user approval; pushes are always forbidden.

## Implementation commands require a validated plan

- An "engaging" command is any request that leads to implementation work: implementing, fixing, refactoring, adding features, or otherwise changing code or files. It is never an assessment-only request.
- Before starting any engaging command, first produce a precise plan that contains:
  - Objective, scope, and constraints.
  - Checkbox tasks with acceptance criteria.
  - Exact validation tests and gates: concrete commands (for example `cargo test --locked <module>`, `cargo clippy --locked --all-targets -- -D warnings`, format checks) with their expected outcome.
- Present the plan for validation before doing the work, unless the user already explicitly authorized implementation (for example "implement", "fix", "do the development", "apply the plan").
- Persist the plan to disk (project `plan/` directory) so it survives context loss and is shared across agents; re-read it from disk at each step instead of relying on session memory. Always create the plan file on disk (`plan/<YYYY-MM-DD>-<type>-plan.md`), never keep the plan only in chat/session memory.
- Always split the plan into small, precise tasks: each task must be atomic, independently testable, have a single responsibility and an explicit acceptance criterion. Any task that is too large or vague must be split further.
- Mark parallelizable tasks explicitly: annotate each task with `[parallel: true]` or `[parallel: false]`, and group tasks that can run at the same time. Tasks that touch the same files must never run in parallel. Add a `depends: <task>` note when a task requires another to finish first.
- Creating the dedicated implementation branch `fix/audit-<slug>` is automatically authorized only after a validated plan exists or the user explicitly authorized implementation; this exact branch creation is not unauthorized branch creation. Any other branch creation, branch switch, merge, branch deletion, or history rewrite requires approval or is denied by the agent's git rules.
- A task is done only after its exact tests and gates pass. Never mark a task done without running its tests, never skip, weaken, or delete tests to make them pass, and never revert/reset code that was already validated.
- If a task cannot be completed or its tests cannot pass, stop and report instead of guessing or inventing a solution.

## CHANGELOG.md template

When updating CHANGELOG.md, use this template. Never modify an existing released version: only add or modify the `Unreleased` section.

```markdown
# Changelog

All notable changes to this project will be documented in this file.

The format is inspired by [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to semantic versioning.

## [Unreleased]

## [1.0.1] - 2026-08-06
```
