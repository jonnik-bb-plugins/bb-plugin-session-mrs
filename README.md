# Session MRs

A BB plugin that shows every GitLab merge request and GitHub pull request linked
in the current thread, with live state, pipeline/checks status and a clickable
link.

## What you get

- A **Merge requests** section in the thread context card and in the thread Info
  tab. One row per MR: `repo !123` (GitLab) or `owner/repo #45` (GitHub), the
  title, a state chip (Draft / Open / Merged / Closed) and the pipeline or checks
  result (`✓` / `✗` / `…`). Clicking a row opens the MR in the browser. The
  section is hidden when the thread links no MR. It refetches on mount, when the
  thread changes, and every 60 seconds; the refresh icon forces a fresh read.
- `bb session-mrs list [--thread <id>] [--refresh] [--json]` and
  `bb session-mrs status <url> [--json]` for agents and shells. See
  `skills/session-mrs/SKILL.md`.

## How it works

- `lib/mr.ts` extracts and canonicalizes URLs (GitLab `https://<host>/<group
  path>/-/merge_requests/<iid>`, GitHub `https://github.com/<owner>/<repo>/pull/<n>`)
  and maps API payloads to one status shape.
- `server.ts` reads the thread's raw events page by page (user input and
  completed items, which include command output; the timeline view collapses
  tool output), keeps at most 50 links, and fetches status with `glab api` /
  `gh pr view` through `execFile` (15 s timeout, 4 at a time, binaries resolved
  against PATH plus `/opt/homebrew/bin`, `/usr/local/bin`, `/usr/bin`). A failed
  lookup keeps its row with an error marker.
- Caches (memory only): per-URL status for 60 s; per-thread link list until the
  thread's next `thread.idle`. RPC: `listThreadMergeRequests({ threadId,
  refresh? })`.

## Requirements

`glab` (authenticated for each GitLab host) and/or `gh` (authenticated for
github.com) on the machine that runs the BB server. The plugin never stores or
prints credentials.

## Development

```
npm install
npm test            # node --test: URL extraction and status mapping
npm run typecheck
bb plugin build
bb plugin install .
```
