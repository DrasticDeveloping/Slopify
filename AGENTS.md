# AGENTS.md

## Working approach

- Complete the requested work and appropriate verification. Keep requests for drafts, plans, or reviews scoped to that output.
- Stay within the requested scope.
- Use reasonable judgment for routine decisions. Ask focused questions when missing information materially affects the result.
- While waiting for clarification, continue only work that does not depend on the answer.
- Treat follow-up messages as guidance for the current task unless the user changes or cancels it.

## Authorization

- Continue work already authorized by the user without repeatedly asking for confirmation.
- When approval is needed, prepare a reviewable diff, draft, or proposed command without performing the action requiring approval.
- Get approval for destructive or consequential actions outside the authorized scope.
- Commit, push, rewrite history, or publish only when those actions are within the user's authorization. Force-pushing requires specific authorization.
- Do not discard or revert changes you did not make unless the user explicitly requests it.
- Send messages to other people or share project data externally only when authorized.
- If an action is blocked, explain the specific restriction and continue unaffected work.

## Communication

- Use concise, direct language. Explain technical details when they help the user understand the result.
- During longer tasks, give brief updates about findings, decisions, and remaining work.
- Clearly distinguish facts, assumptions, and unverified claims.
- Finish with what changed, how it was checked, and unresolved limitations.
- Include useful links to changed files or review artifacts.

## Implementation

- Read applicable repository guidance and inspect relevant code before editing.
- Follow established conventions and keep changes focused.
- Preserve existing user edits and unrelated work.
- Fix the underlying cause when practical, keeping the solution proportional to the problem.
- Avoid adding dependencies or abstractions without a clear benefit.
- Never expose credentials or sensitive data in commands, logs, or responses.

## Tools and research

- Prefer purpose-built tools and documented project workflows.
- Use `rg` and `rg --files` for searches when available.
- Batch independent reads and searches. Keep dependent operations and overlapping edits sequential.
- Consult current primary documentation when behavior is uncertain or may have changed.
- Read relevant skill instructions before using a skill. Explain any skill requirement that blocks progress.
- Follow the user's requested output format and destination.
- When the user requests a draft, plan, or proposal, keep it in chat unless saving it is part of the request.

## Verification and independent review

- Run checks appropriate to the change and complete required project checks.
- Verify affected behavior and relevant failure cases. Keep verification proportional to the change.
- Do not claim a check passed unless it was actually run successfully.
- If a required check fails or cannot run, report that and explain the reason.
- When checking completed work, request an independent review from a new subagent or review thread.
- Every reviewer and other subagent must start with a fresh context window and a self-contained brief. Do not fork the conversation.
- Give the reviewer the user's request, why the work was requested, scope exclusions, the proposed result, verification evidence, and known concerns.
- Ask the reviewer to decide whether the result is good enough and identify concrete gaps.
- Reviewers report findings only. They do not edit files or launch further agents.
- Address material findings before handing the work back. Explain any finding you decline.
- Request another review only when substantial fixes or unresolved concerns justify it.
- Use at most two broad independent review rounds per task unless the user requests more. Short smoke gates and targeted rechecks of concrete fixes are verification steps; do not relabel a full review as a targeted check to bypass this limit. Continue fixing concrete issues and report unresolved limitations.

## Efficient implementation and verification

- GPT-6.1-Sol handles this project's compile/build checks, testing, and bug finding. The implementor writes code and fixes reported defects. Keep every delegation fresh and self-contained.
- As soon as the basic app shell runs, delegate a short gate: typecheck, build, normal startup, and reload. Stop broad QA if startup fails; report the blocker immediately and fix it before continuing. Do not build elaborate bypass fixtures or proxies unless the user specifically requests isolated testing.
- After code fixes, delegate the smallest checks that verify the affected behavior before another broad review. Relevant regressions include two consecutive persistence reloads, crossfade/pause/clip boundaries, and menu -> dialog -> Cancel/Escape focus restoration. Document-only changes need a document review, not app builds or browser tests.
- Use patches scoped to the intended function or class. Avoid file-wide string replacements for repeated code; if a scripted replacement is necessary, assert its intended match count and inspect the diff.

## Stable QA handoffs

- Bind each review to a fixed source snapshot; execution/browser QA also needs a dedicated server URL. Include uncommitted changes and the files required for the checks, including the lockfile, backend, and runtime configuration when applicable. A commit hash alone does not identify dirty source. Use an authorized checkpoint or an immutable copy outside the repo. Do not commit merely to create a QA snapshot.
- Keep implementation edits separate from the reviewed snapshot. If isolation is unavailable, pause edits to the reviewed files until the reviewer finishes. If the app refreshes unexpectedly, invalidate affected checks and rerun only those checks against an identified version.
- Each brief must include the user's request and reason, exact snapshot/path and URL when applicable, test ownership, relevant previous findings and fixes, known environment restrictions and validated remedies, and a bounded checklist. Split code review and browser QA responsibilities to avoid duplicate full regressions. Return verified findings with reproduction steps and the tested snapshot.

## Tool failures and browser state

- Never repeat an identical tool call after an actionable schema or argument error. Correct the arguments first. Record reusable tool constraints in the next handoff so fresh reviewers do not repeat them.
- With T3 browser locators, do not append `[exact=true]`; it is unsupported. Use locators from the current snapshot or supported scoped selectors. Use the documented key name for Space, not a literal whitespace key.
- After a browser timeout or missing element, take a fresh snapshot and check the route, dialog, viewport, visibility, and tab ownership before trying again. Do not type or click inside a dialog until opening it succeeds. Prefer the visible mobile navigation when desktop controls are hidden.
- Retry a transient failure at most once, with an explicit reason. A second failure requires diagnosis or a supported alternative; do not continue a chain of actions whose prerequisite failed. Keep outputs bounded: return selected values rather than whole DOM trees or repeated full source dumps.

## Windows preflight

- In Windows PowerShell, use `npm.cmd` and `npx.cmd` to avoid blocked `.ps1` shims. Read package scripts and config files before choosing commands; this app uses `tsconfig.json`, not `tsconfig.app.json`.
- For this app, the standard checks are `npm.cmd run typecheck` and `npm.cmd run build`, executed in the reviewed snapshot. Run dependent checks sequentially and stop when a required check fails.
- A Vite build `spawn EPERM` may be a sandbox restriction. Use the supported permission retry only when permitted; preserve the exact command and report any rejection. Do not disable execution policy, relax sandboxing globally, or treat an environment failure as an application defect.
- Carry working commands, actual paths, tool syntax, and any permitted retry procedure into subsequent briefs. Do not ask a fresh reviewer to rediscover them.

## Dev server lifecycle

- Prefer app-managed launch tasks when available. Before launching or restarting, check the requested port and identify its owning process and command line. Reuse a healthy server for the same snapshot; use another port for a separate snapshot. Never kill an unrelated listener.
- Record the actual server PID, snapshot/path, URL, launch command, and log location. A stopped command wrapper does not prove its child server stopped. Check the child process and HTTP readiness before restarting or claiming the app is available.
- Use hidden windows for background helpers. Preserve the existing server during review unless a restart is necessary; coordinate any restart with the reviewer. Stop or clean up owned resources only within the user's authorization.

## Checkpoints and provider limits

- Before a long handoff and after a meaningful batch of fixes, update a concise project checkpoint with completed work, remaining work, snapshot/path, relevant findings, working commands, server ownership, and known blockers. Use an existing project note location or `docs/agent-checkpoint.md`; omit secrets and large logs. A resumable checkpoint does not require a commit.
- When a provider reports a usage limit, record the exact reset time if supplied and stop automatic retries until reset. If it appears in logs after interruption, reconstruct the checkpoint from the current source and reports before resuming. A user-requested retry may be attempted once; another rejection should be reported without a retry loop.
- Use a fallback provider only if the user has authorized it, and supply the checkpoint without replacing an explicitly requested reviewer model. Do not create schedules unless the user requests them. Distinguish productive verification, avoidable retries, and provider restrictions; do not invent token-cost estimates.
