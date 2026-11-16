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
  updatedAt?: string;
  webUrl?: string;
  /** Set when the live fetch failed; the row keeps its URL and ref. */
  error?: string;
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
    updatedAt: str(pr.updatedAt),
    webUrl: str(pr.url) ?? ref.url,
  };
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
export function formatTable(rows: MrStatus[]): string {
  if (rows.length === 0) return "No merge requests linked in this thread.";
  const lines = rows.map((r) => [
    cell(r.ref, 40),
    cell(stateLabel(r), 8),
    r.error ? "-" : pipelineSymbol(r.pipeline),
    cell(r.error ? `(${r.error})` : (r.title ?? ""), 60),
    r.webUrl ?? r.url,
  ]);
  const head = ["REF", "STATE", "CI", "TITLE", "URL"];
  const widths = head.map((h, i) => Math.max(h.length, ...lines.map((l) => l[i]!.length)));
  const fmt = (l: string[]) => l.map((c, i) => (i === l.length - 1 ? c : c.padEnd(widths[i]!))).join("  ");
  return [fmt(head), ...lines.map(fmt)].join("\n");
}
