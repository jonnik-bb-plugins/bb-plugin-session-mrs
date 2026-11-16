---
name: session-mrs
description: List the GitLab merge requests and GitHub pull requests a BB thread created, with live state and pipeline status, using the `bb session-mrs` CLI. Use when the user asks what MRs/PRs a session opened (not every MR it mentions), whether they are merged or green, or for their links.
---

# Session MRs

The Session MRs plugin finds the MRs/PRs **this thread created** and fetches
each one's live status. An MR counts as created when it is linked in the
thread's events (subagents included) and either

- (a) a successful command or tool that creates one printed its URL: `glab mr
  create`, `gh pr create`, `git push -o merge_request.create`, a POST to
  `.../merge_requests` or `/pulls` via `glab api`/`gh api`/`curl`, or an MCP
  `create_merge_request` / `create_pull_request` tool; or
- (b) it was created between the thread's creation and last activity by the
  account `glab`/`gh` is logged in as.

Everything else is "mentioned only" and hidden.

## Commands

| Command | Effect |
| --- | --- |
| `bb session-mrs list [--thread <id>] [--refresh] [--mentioned] [--json]` | Table of ref, state, pipeline, title, url, sorted open, draft, merged, closed. Defaults to the current thread. Only MRs the thread created, and only links that resolve to a real MR/PR (not 404, no access, unknown host). `--mentioned` also lists mentioned-only and unresolved links and adds an `ORIGIN` column (`created` / `mentioned`; also a field in `--json`). |
| `bb session-mrs status <url> [--json]` | Live status of one GitLab MR or GitHub PR URL. |

Columns: `STATE` is Open, Draft, Merged, Closed, or Error. `CI` is `✓` passed,
`✗` failed, `…` running, `-` none or unknown.

## Constraints

- Read-only: nothing is merged, approved, or commented.
- At most 50 mentioned links per thread (creations are always kept),
  deduplicated by canonical URL.
- Status comes from the machine's own `glab` (any GitLab host) and `gh`
  (github.com) logins. A row whose host the CLI cannot reach shows
  `Error` with the reason instead of failing the command.
- Status is cached for 60 seconds; the link list is re-read after the thread
  finishes a turn. `--refresh` bypasses both. A thread with many links can take
  tens of seconds on the first call (4 lookups at a time).
