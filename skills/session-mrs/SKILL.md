---
name: session-mrs
description: List the GitLab merge requests and GitHub pull requests linked in a BB thread, with live state and pipeline status, using the `bb session-mrs` CLI. Use when the user asks what MRs/PRs a session opened, whether they are merged or green, or for their links.
---

# Session MRs

The Session MRs plugin scans a thread (user messages, agent replies, command
output) for MR/PR URLs and fetches each one's live status.

## Commands

| Command | Effect |
| --- | --- |
| `bb session-mrs list [--thread <id>] [--refresh] [--all] [--json]` | Table of ref, state, pipeline, title, url, sorted open, draft, merged, closed. Defaults to the current thread. Links that do not resolve to a real MR/PR (404, no access, unknown host) are hidden; `--all` includes them. |
| `bb session-mrs status <url> [--json]` | Live status of one GitLab MR or GitHub PR URL. |

Columns: `STATE` is Open, Draft, Merged, Closed, or Error. `CI` is `✓` passed,
`✗` failed, `…` running, `-` none or unknown.

## Constraints

- Read-only: nothing is merged, approved, or commented.
- At most 50 links per thread, in order of first appearance, deduplicated by
  canonical URL.
- Status comes from the machine's own `glab` (any GitLab host) and `gh`
  (github.com) logins. A row whose host the CLI cannot reach shows
  `Error` with the reason instead of failing the command.
- Status is cached for 60 seconds; the link list is re-read after the thread
  finishes a turn. `--refresh` bypasses both. A thread with many links can take
  tens of seconds on the first call (4 lookups at a time).
