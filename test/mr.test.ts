import assert from "node:assert/strict";
import { test } from "node:test";
import {
  classifyError,
  createdByThreadFallback,
  extractCreatedUrls,
  isCreateCommand,
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
  for (const m of ["timed out", "connect ETIMEDOUT 1.2.3.4:443", "ECONNRESET", "glab: 502 Bad Gateway (HTTP 502)", "glab not found", "API rate limit exceeded", 'Get "https://h/api": net/http: TLS handshake timeout']) {
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

// Fixtures follow real thread events: item/completed with data.item.
const cmd = (command: string, aggregatedOutput: string, exitCode = 0, extra = {}) => ({
  type: "item/completed",
  data: { item: { type: "commandExecution", command, aggregatedOutput, exitCode, ...extra } },
});
const tool = (name: string, result: unknown, status = "completed") => ({
  type: "item/completed",
  data: { item: { type: "toolCall", tool: name, arguments: {}, result, status } },
});
const GL = "https://gitlab.example.com/acme/tools/widgets/-/merge_requests";

test("(a) creation evidence: glab mr create, incl. subagent items", () => {
  const rows = [
    cmd(
      "git push -u origin b 2>&1 | tail -4; glab mr create -R acme/tools/widgets --draft --yes 2>&1 | tail -3",
      `Creating draft merge request for b into main\n\n${GL}/93`,
    ),
    cmd("glab mr create --yes", `${GL}/94`, 0, { parentToolCallId: "toolu_1" }),
    cmd("glab mr view 91", `${GL}/91`),
    cmd("glab mr create --yes", `${GL}/92`, 1),
    { type: "client/turn/requested", data: { input: [{ type: "text", text: `see ${GL}/90` }] } },
  ];
  assert.deepEqual([...extractCreatedUrls(rows)].sort(), [`${GL}/93`, `${GL}/94`]);
});

test("(a) git push -o merge_request.create, gh pr create, API POST, MCP tool", () => {
  const rows = [
    cmd("git push -o merge_request.create -o merge_request.target=main origin x", `remote: View merge request for x:\nremote:   ${GL}/5\n`),
    cmd("gh pr create --fill", "https://github.com/acme/widgets/pull/7\n"),
    cmd("glab api projects/g%2Fp/merge_requests -X POST -f title=t", JSON.stringify({ web_url: `${GL}/6` })),
    cmd("curl -s -X POST https://api.github.com/repos/a/b/pulls -d '{}'", JSON.stringify({ html_url: "https://github.com/a/b/pull/8" })),
    tool("mcp__gitlab__create_merge_request", { web_url: `${GL}/9` }),
    tool("mcp__github__create_pull_request", "https://github.com/a/b/pull/10", "failed"),
    cmd("glab api projects/g%2Fp/merge_requests/11/notes -f body=hi", `${GL}/11`),
    cmd("glab api projects/g%2Fp/merge_requests/12", `${GL}/12`),
  ];
  assert.deepEqual(
    [...extractCreatedUrls(rows)].sort(),
    [`${GL}/5`, `${GL}/6`, `${GL}/9`, "https://github.com/acme/widgets/pull/7", "https://github.com/a/b/pull/8"].sort(),
  );
  assert.ok(isCreateCommand("glab mr create"));
  assert.ok(!isCreateCommand("glab mr list"));
});

test("(b) fallback: inside the thread's lifetime and authored by the CLI user", () => {
  const win = { createdAt: Date.parse("2026-11-16T10:00:00Z"), updatedAt: Date.parse("2026-11-16T12:00:00Z") };
  const mr = (createdAt: string, author = "me") => ({ createdAt, author });
  assert.ok(createdByThreadFallback(mr("2026-11-16T11:00:00Z"), win, "me"));
  assert.ok(createdByThreadFallback(mr("2026-11-16T10:00:00Z", "ME"), win, "me"));
  assert.ok(createdByThreadFallback(mr("2026-11-16T12:00:00Z"), win, "me"));
  assert.ok(!createdByThreadFallback(mr("2026-11-16T09:59:59Z"), win, "me"));
  assert.ok(!createdByThreadFallback(mr("2026-11-16T12:00:01Z"), win, "me"));
  assert.ok(!createdByThreadFallback(mr("2026-11-16T11:00:00Z", "other"), win, "me"));
  assert.ok(!createdByThreadFallback(mr("2026-11-16T11:00:00Z"), win, null));
  assert.ok(!createdByThreadFallback(mr("2026-11-16T11:00:00Z"), null, "me"));
  assert.ok(!createdByThreadFallback({ author: "me" }, win, "me"));
});

test("(a) ignores creation text inside a heredoc body", () => {
  const script = "python3 - <<'EOF'\nrun('glab mr create --yes')\nEOF\nnpm test";
  assert.ok(!isCreateCommand(script));
  assert.ok(isCreateCommand("cat > d.md <<'EOF'\nbody\nEOF\nglab mr create --description \"$(cat d.md)\""));
  assert.equal(extractCreatedUrls([cmd(script, `${GL}/5`)]).size, 0);
});
