// Pure helpers: MR/PR URL extraction and status mapping. No SDK or I/O, so
// node --test can load this file directly.

export type MrProvider = "gitlab" | "github";
export type MrState = "open" | "merged" | "closed";
export type PipelineStatus = "success" | "failure" | "pending" | "none";

export interface MrRef {
  provider: MrProvider;
  host: string;
  /** GitLab: full project path (nested groups); GitHub: `owner/repo`. */
  project: string;
  number: number;
  /** Canonical URL, the dedupe key. */
  url: string;
  /** Compact label: `repo !123` (GitLab) or `owner/repo #45` (GitHub). */
  ref: string;
}

export interface MrStatus extends MrRef {
  title?: string;
  state?: MrState;
  draft?: boolean;
  pipeline?: PipelineStatus;
  mergeStatus?: string;
  sourceBranch?: string;
  targetBranch?: string;
  author?: string;
  createdAt?: string;
  updatedAt?: string;
  webUrl?: string;
  /** `created`: this thread opened it; `mentioned`: only linked in the thread. */
  origin?: "created" | "mentioned";
  /** Set when the live fetch failed; the row keeps its URL and ref. */
  error?: string;
  /** `permanent`: the link does not resolve to a real MR/PR (hidden by default). */
  errorKind?: "transient" | "permanent";
}

export const MAX_MRS_PER_THREAD = 50;

// The character classes stop at whitespace, quotes, backticks, brackets and
// parentheses, so markdown wrapping and trailing punctuation never leak in.
// Whatever follows the number (/diffs, #note_1, ?query) is simply not matched.
const GITLAB_RE =
  /https?:\/\/([A-Za-z0-9][A-Za-z0-9.-]*(?::\d+)?)\/((?:[A-Za-z0-9._~%-]+\/)+)-\/merge_requests\/(\d+)(?!\d)/g;
const GITHUB_RE =
  /https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/(\d+)(?!\d)/g;

function gitlabRef(host: string, pathWithSlash: string, iid: string): MrRef {
  const project = pathWithSlash.replace(/\/$/, "");
  const h = host.toLowerCase();
  const number = Number(iid);
  return {
    provider: "gitlab",
    host: h,
    project,
    number,
    url: `https://${h}/${project}/-/merge_requests/${number}`,
    ref: `${project.split("/").pop()} !${number}`,
  };
}

function githubRef(owner: string, repo: string, n: string): MrRef {
  const number = Number(n);
  return {
    provider: "github",
    host: "github.com",
    project: `${owner}/${repo}`,
    number,
    url: `https://github.com/${owner}/${repo}/pull/${number}`,
    ref: `${owner}/${repo} #${number}`,
  };
}

/** Every MR/PR URL in `text`, canonical, deduped, in order of first appearance. */
export function extractMrRefs(text: string, max = MAX_MRS_PER_THREAD): MrRef[] {
  const found: { index: number; ref: MrRef }[] = [];
  for (const m of text.matchAll(GITLAB_RE)) {
    found.push({ index: m.index, ref: gitlabRef(m[1]!, m[2]!, m[3]!) });
  }
  for (const m of text.matchAll(GITHUB_RE)) {
    found.push({ index: m.index, ref: githubRef(m[1]!, m[2]!, m[3]!) });
  }
  found.sort((a, b) => a.index - b.index);
  const seen = new Map<string, MrRef>();
  for (const { ref } of found) {
    if (!seen.has(ref.url)) seen.set(ref.url, ref);
    if (seen.size >= max) break;
  }
  return [...seen.values()];
}

/** The single MR/PR a string names, or null. */
export function parseMrUrl(input: string): MrRef | null {
  return extractMrRefs(input.trim(), 1)[0] ?? null;
}

const GITLAB_PIPELINE: Record<string, PipelineStatus> = {
  success: "success",
  failed: "failure",
  running: "pending",
  pending: "pending",
  created: "pending",
  preparing: "pending",
  waiting_for_resource: "pending",
  scheduled: "pending",
};

function str(v: unknown): string | undefined {
  return typeof v === "string" && v !== "" ? v : undefined;
}

/** Map the `merge_requests/:iid` API payload onto the ref. */
export function mapGitlabMr(ref: MrRef, mr: any): MrStatus {
  const state =
    mr.state === "merged" ? "merged" : mr.state === "closed" ? "closed" : "open";
  return {
    ...ref,
    title: str(mr.title),
    state,
    draft: Boolean(mr.draft ?? mr.work_in_progress),
    pipeline: GITLAB_PIPELINE[mr.head_pipeline?.status] ?? "none",
    mergeStatus: str(mr.detailed_merge_status),
    sourceBranch: str(mr.source_branch),
    targetBranch: str(mr.target_branch),
    author: str(mr.author?.username),
    createdAt: str(mr.created_at),
    updatedAt: str(mr.updated_at),
    webUrl: str(mr.web_url) ?? ref.url,
  };
}

/** Collapse gh's statusCheckRollup (CheckRun and StatusContext entries). */
export function summarizeChecks(rollup: unknown): PipelineStatus {
  if (!Array.isArray(rollup) || rollup.length === 0) return "none";
  let pending = false;
  for (const c of rollup) {
    const verdict = String(c?.conclusion || c?.state || "").toUpperCase();
    if (["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "STARTUP_FAILURE", "ACTION_REQUIRED"].includes(verdict)) {
      return "failure";
    }
    const status = String(c?.status || "").toUpperCase();
    if (
      (status !== "" && status !== "COMPLETED") ||
      verdict === "PENDING" ||
      verdict === "EXPECTED" ||
      verdict === ""
    ) {
      pending = true;
    }
  }
  return pending ? "pending" : "success";
}

/** Map `gh pr view --json …` output onto the ref. */
export function mapGithubPr(ref: MrRef, pr: any): MrStatus {
  const state =
    pr.state === "MERGED" ? "merged" : pr.state === "CLOSED" ? "closed" : "open";
  return {
    ...ref,
    title: str(pr.title),
    state,
    draft: Boolean(pr.isDraft),
    pipeline: summarizeChecks(pr.statusCheckRollup),
    mergeStatus: str(pr.mergeStateStatus),
    sourceBranch: str(pr.headRefName),
    targetBranch: str(pr.baseRefName),
    author: str(pr.author?.login),
    createdAt: str(pr.createdAt),
    updatedAt: str(pr.updatedAt),
    webUrl: str(pr.url) ?? ref.url,
  };
}

// Timeouts, network trouble, 5xx, rate limits and a missing CLI say nothing
// about the link itself; any other failure (404, 401/403, unknown host or
// project, GraphQL "Could not resolve") means it is not a reachable MR/PR.
const TRANSIENT_RE =
  /timed out|timeout|TLS handshake|ETIMEDOUT|ECONN|EAI_AGAIN|ENETUNREACH|network is unreachable|connection (reset|refused)|HTTP 5\d\d|\b5\d\d (bad|service|gateway|internal)|bad gateway|service unavailable|rate limit|(glab|gh) not found/i;

export function classifyError(message: string): "transient" | "permanent" {
  return TRANSIENT_RE.test(message) ? "transient" : "permanent";
}

const STATE_RANK = { open: 0, merged: 2, closed: 3 } as const;

function rank(mr: MrStatus): number {
  if (mr.error || !mr.state) return 4;
  return mr.state === "open" && mr.draft ? 1 : STATE_RANK[mr.state];
}

/** Open, draft, merged, closed, unavailable; most recently updated first within each. */
export function sortMrs(rows: MrStatus[]): MrStatus[] {
  return rows
    .map((row, i) => ({ row, i }))
    .sort(
      (a, b) =>
        rank(a.row) - rank(b.row) ||
        (b.row.updatedAt ?? "").localeCompare(a.row.updatedAt ?? "") ||
        a.i - b.i,
    )
    .map(({ row }) => row);
}

/** Drop links that do not resolve to a real MR/PR. */
export function visibleMrs(rows: MrStatus[]): MrStatus[] {
  return rows.filter((r) => r.errorKind !== "permanent");
}

// --- Which MRs did the thread itself create? ---------------------------------

const CREATE_CMD_RE = /\bglab\s+mr\s+create\b|\bgh\s+pr\s+create\b|merge_request\.create/;
// A POST straight to the collection (`…/merge_requests`, `…/pulls`), not to a
// sub-resource such as `merge_requests/5/notes`.
const API_CREATE_RE = /\b(glab\s+api|gh\s+api|curl)\b/;
const API_COLLECTION_RE = /(merge_requests|\/pulls)(?![\w/-])/;
const API_POST_RE = /-X\s*POST|--method[ =]\s*POST|\s-[fFd]\s|--(?:raw-)?field\b|--data\b/i;
const CREATE_TOOL_RE = /create_merge_request|create_pull_request/i;

/** Does this command line open an MR/PR? */
export function isCreateCommand(rawCommand: string): boolean {
  // Heredoc bodies are data (an MR description, a script being written), not commands.
  const command = rawCommand.replace(/<<-?\s*(['"]?)(\w+)\1[^\n]*\n[\s\S]*?\n\s*\2(?=\s|$)/g, "<<heredoc");
  return (
    CREATE_CMD_RE.test(command) ||
    (API_CREATE_RE.test(command) && API_COLLECTION_RE.test(command) && API_POST_RE.test(command))
  );
}

function outputText(v: unknown): string {
  return typeof v === "string" ? v : v == null ? "" : JSON.stringify(v);
}

/**
 * URLs printed by a successful command/tool item that creates an MR/PR (rule a).
 * Rows are raw thread events; subagent items arrive in the same stream.
 * Shapes: `item/completed` with `data.item` = `{ type: "commandExecution",
 * command, aggregatedOutput, exitCode }` or `{ type: "toolCall", tool,
 * arguments, result, status }`.
 */
export function extractCreatedUrls(rows: unknown[]): Set<string> {
  const urls = new Set<string>();
  for (const row of rows as any[]) {
    if (row?.type !== "item/completed") continue;
    const item = row.data?.item;
    let out: string | null = null;
    if (item?.type === "commandExecution") {
      if (item.exitCode === 0 && isCreateCommand(String(item.command ?? ""))) out = outputText(item.aggregatedOutput);
    } else if (item?.type === "toolCall") {
      if (item.status === "completed" && CREATE_TOOL_RE.test(String(item.tool ?? ""))) out = outputText(item.result);
    }
    if (out) for (const ref of extractMrRefs(out)) urls.add(ref.url);
  }
  return urls;
}

/** Rule (b): created inside the thread's lifetime by the CLI's own user. */
export function createdByThreadFallback(
  mr: Pick<MrStatus, "createdAt" | "author">,
  window: { createdAt: number; updatedAt: number } | null,
  user: string | null,
): boolean {
  if (!window || !user || !mr.author || !mr.createdAt) return false;
  const t = Date.parse(mr.createdAt);
  return (
    mr.author.toLowerCase() === user.toLowerCase() &&
    Number.isFinite(t) &&
    t >= window.createdAt &&
    t <= window.updatedAt
  );
}

/** Chip label: draft wins over open. */
export function stateLabel(mr: Pick<MrStatus, "state" | "draft" | "error">): string {
  if (mr.error) return "Error";
  if (mr.state === "open") return mr.draft ? "Draft" : "Open";
  if (mr.state === "merged") return "Merged";
  if (mr.state === "closed") return "Closed";
  return "?";
}

export function pipelineSymbol(p: PipelineStatus | undefined): string {
  return p === "success" ? "✓" : p === "failure" ? "✗" : p === "pending" ? "…" : "-";
}

function cell(s: string, max: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Bounded plain-text table for the CLI: ref, state, pipeline, title, url. */
export function formatTable(rows: MrStatus[], showOrigin = false): string {
  if (rows.length === 0) return "No merge requests created by this thread.";
  const lines = rows.map((r) => [
    cell(r.ref, 40),
    cell(stateLabel(r), 8),
    r.error ? "-" : pipelineSymbol(r.pipeline),
    cell(r.error ? `(${r.error})` : (r.title ?? ""), 60),
    r.webUrl ?? r.url,
    ...(showOrigin ? [r.origin ?? ""] : []),
  ]);
  const head = ["REF", "STATE", "CI", "TITLE", "URL", ...(showOrigin ? ["ORIGIN"] : [])];
  const widths = head.map((h, i) => Math.max(h.length, ...lines.map((l) => l[i]!.length)));
  const fmt = (l: string[]) => l.map((c, i) => (i === l.length - 1 ? c : c.padEnd(widths[i]!))).join("  ");
  return [fmt(head), ...lines.map(fmt)].join("\n");
}
