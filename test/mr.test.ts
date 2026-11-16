import assert from "node:assert/strict";
import { test } from "node:test";
import {
  classifyError,
  extractMrRefs,
  formatTable,
  mapGithubPr,
  mapGitlabMr,
  parseMrUrl,
  sortMrs,
  stateLabel,
  summarizeChecks,
  visibleMrs,
  type MrStatus,
} from "../lib/mr.ts";

const urls = (t: string, max?: number) => extractMrRefs(t, max).map((r) => r.url);

test("gitlab: nested groups, canonical url and ref", () => {
  const [r] = extractMrRefs("see https://gitlab.example.com/acme/backend/api/-/merge_requests/123 ok");
  assert.equal(r!.url, "https://gitlab.example.com/acme/backend/api/-/merge_requests/123");
  assert.equal(r!.project, "acme/backend/api");
  assert.equal(r!.ref, "api !123");
  assert.equal(r!.provider, "gitlab");
});

test("gitlab: strips /diffs, /commits, #note, query", () => {
  const base = "https://gitlab.com/g/p/-/merge_requests/7";
  for (const suffix of ["/diffs", "/commits", "#note_55", "?tab=changes", "/diffs?commit_id=abc#x"]) {
    assert.deepEqual(urls(`${base}${suffix}`), [base], suffix);
  }
});

test("markdown wrapping and trailing punctuation", () => {
  const u = "https://gitlab.com/g/p/-/merge_requests/7";
  for (const t of [`[mr](${u})`, `(${u}).`, `\`${u}\``, `<${u}>,`, `"${u}"`, `${u}.`, `${u}\\n next`]) {
    assert.deepEqual(urls(t), [u], t);
  }
});

test("github pull urls", () => {
  const [r] = extractMrRefs("PR https://github.com/acme/widgets/pull/45/files, done");
  assert.equal(r!.url, "https://github.com/acme/widgets/pull/45");
  assert.equal(r!.ref, "acme/widgets #45");
  assert.equal(r!.provider, "github");
});

test("dedupe keeps first-appearance order across providers", () => {
  const t = [
    "https://github.com/a/b/pull/1",
    "https://gitlab.com/g/p/-/merge_requests/2/diffs",
    "https://github.com/a/b/pull/1#issuecomment-1",
    "https://gitlab.com/g/p/-/merge_requests/2",
    "https://gitlab.com/g/p/-/merge_requests/3",
  ].join("\n");
  assert.deepEqual(urls(t), [
    "https://github.com/a/b/pull/1",
    "https://gitlab.com/g/p/-/merge_requests/2",
    "https://gitlab.com/g/p/-/merge_requests/3",
  ]);
});

test("max bound and non-matches", () => {
  const t = Array.from({ length: 80 }, (_, i) => `https://gitlab.com/g/p/-/merge_requests/${i + 1}`).join(" ");
  assert.equal(extractMrRefs(t).length, 50);
  assert.equal(urls(t, 3).length, 3);
  assert.deepEqual(urls("https://gitlab.com/g/p/-/merge_requests/new https://gitlab.com/g/p/-/issues/3"), []);
  assert.equal(parseMrUrl("not a url"), null);
  assert.equal(parseMrUrl("https://-bad/g/p/-/merge_requests/1"), null);
});

test("gitlab status mapping", () => {
  const ref = extractMrRefs("https://gitlab.com/g/p/-/merge_requests/7")[0]!;
  const s = mapGitlabMr(ref, {
    title: "Fix", state: "opened", draft: true, detailed_merge_status: "mergeable",
    source_branch: "f", target_branch: "stage", head_pipeline: { status: "running" },
    web_url: "https://gitlab.com/g/p/-/merge_requests/7", author: { username: "me" }, updated_at: "t",
  });
  assert.equal(stateLabel(s), "Draft");
  assert.equal(s.pipeline, "pending");
  assert.equal(s.author, "me");
  assert.equal(mapGitlabMr(ref, { state: "merged", head_pipeline: { status: "success" } }).pipeline, "success");
  assert.equal(stateLabel(mapGitlabMr(ref, { state: "closed", head_pipeline: null })), "Closed");
  assert.equal(mapGitlabMr(ref, { state: "opened", head_pipeline: { status: "failed" } }).pipeline, "failure");
  assert.equal(mapGitlabMr(ref, { state: "opened" }).pipeline, "none");
  assert.equal(stateLabel(mapGitlabMr(ref, { state: "opened" })), "Open");
});

test("github status mapping and checks rollup", () => {
  assert.equal(summarizeChecks([]), "none");
  assert.equal(summarizeChecks(null), "none");
  assert.equal(summarizeChecks([{ status: "COMPLETED", conclusion: "SUCCESS" }, { status: "COMPLETED", conclusion: "SKIPPED" }]), "success");
  assert.equal(summarizeChecks([{ status: "COMPLETED", conclusion: "SUCCESS" }, { status: "IN_PROGRESS", conclusion: "" }]), "pending");
  assert.equal(summarizeChecks([{ status: "IN_PROGRESS" }, { status: "COMPLETED", conclusion: "FAILURE" }]), "failure");
  assert.equal(summarizeChecks([{ state: "SUCCESS" }]), "success");
  assert.equal(summarizeChecks([{ state: "PENDING" }]), "pending");
  const ref = extractMrRefs("https://github.com/a/b/pull/1")[0]!;
  const s = mapGithubPr(ref, { title: "T", state: "MERGED", isDraft: false, url: "u", headRefName: "h", baseRefName: "b", author: { login: "x" }, statusCheckRollup: [] });
  assert.equal(stateLabel(s), "Merged");
  assert.equal(s.author, "x");
});

test("table is bounded and shows errors", () => {
  const ref = extractMrRefs("https://github.com/a/b/pull/1")[0]!;
  const out = formatTable([{ ...ref, error: "gh failed" }, { ...ref, title: "x".repeat(200), state: "open", pipeline: "success" }]);
  assert.match(out, /Error/);
  assert.match(out, /\(gh failed\)/);
  assert.ok(out.split("\n").every((l) => l.length < 220));
  assert.match(formatTable([]), /No merge requests/);
});

test("error classification: only transient failures are kept", () => {
  for (const m of [
    "glab: 404 Project Not Found (HTTP 404)",
    "glab: 401 Unauthorized (HTTP 401)",
    "gh: HTTP 403: Forbidden",
    "Unauthenticated.",
    "GraphQL: Could not resolve to a Repository with the name 'a/b'.",
    "dial tcp: lookup nope.invalid: no such host",
  ]) assert.equal(classifyError(m), "permanent", m);
  for (const m of ["timed out", "connect ETIMEDOUT 1.2.3.4:443", "ECONNRESET", "glab: 502 Bad Gateway (HTTP 502)", "glab not found", "API rate limit exceeded"]) {
    assert.equal(classifyError(m), "transient", m);
  }
  const ref = extractMrRefs("https://github.com/a/b/pull/1")[0]!;
  const rows: MrStatus[] = [
    { ...ref, state: "open" },
    { ...ref, error: "404", errorKind: "permanent" },
    { ...ref, error: "timed out", errorKind: "transient" },
  ];
  assert.equal(visibleMrs(rows).length, 2);
});

test("sort: open, draft, merged, closed, unavailable; newest first within a group", () => {
  const ref = extractMrRefs("https://github.com/a/b/pull/1")[0]!;
  const mk = (n: number, state: MrStatus["state"], updatedAt?: string, draft = false): MrStatus => ({ ...ref, number: n, state, draft, updatedAt });
  const rows = [
    mk(1, "closed", "2026-01-09"),
    mk(2, "merged", "2026-01-01"),
    mk(3, "open", "2026-01-02", true),
    mk(4, "open", "2026-01-01"),
    mk(5, "merged", "2026-01-05"),
    mk(6, "open", "2026-01-03"),
    { ...ref, number: 7, error: "timed out", errorKind: "transient" as const },
  ];
  assert.deepEqual(sortMrs(rows).map((r) => r.number), [6, 4, 3, 5, 2, 1, 7]);
});
