// bb-plugin-session-mrs — backend: finds the MR/PR links in a thread's
// timeline, fetches their live status through the machine's authenticated
// glab/gh CLIs, and serves them over RPC (frontend) and `bb session-mrs`.
import { execFile } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  extractMrRefs,
  formatTable,
  mapGithubPr,
  MAX_MRS_PER_THREAD,
  mapGitlabMr,
  parseMrUrl,
  type MrRef,
  type MrStatus,
} from "./lib/mr.ts";

const mrStatusSchema = z.object({
  provider: z.enum(["gitlab", "github"]),
  host: z.string(),
  project: z.string(),
  number: z.number(),
  url: z.string(),
  ref: z.string(),
  title: z.string().optional(),
  state: z.enum(["open", "merged", "closed"]).optional(),
  draft: z.boolean().optional(),
  pipeline: z.enum(["success", "failure", "pending", "none"]).optional(),
  mergeStatus: z.string().optional(),
  sourceBranch: z.string().optional(),
  targetBranch: z.string().optional(),
  author: z.string().optional(),
  updatedAt: z.string().optional(),
  webUrl: z.string().optional(),
  error: z.string().optional(),
});

export const rpcContract = defineRpcContract({
  listThreadMergeRequests: {
    input: z.object({
      threadId: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/),
      refresh: z.boolean().optional(),
    }),
    output: z.array(mrStatusSchema),
  },
});

const STATUS_TTL_MS = 60_000;
const CLI_TIMEOUT_MS = 15_000;
const CONCURRENCY = 4;
const CACHE_CAP = 500;
const EVENT_PAGE_SIZE = 100;
const MAX_EVENT_PAGES = 150;

const FALLBACK_DIRS = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"];

/** Resolve a CLI by absolute path: the server's PATH may lack Homebrew. */
function resolveBin(name: string): string | null {
  const dirs = [...(process.env.PATH ?? "").split(delimiter), ...FALLBACK_DIRS];
  for (const dir of dirs) {
    if (dir === "") continue;
    const candidate = join(dir, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      /* try next */
    }
  }
  return null;
}

function run(bin: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      bin,
      args,
      {
        timeout: CLI_TIMEOUT_MS,
        maxBuffer: 4 * 1024 * 1024,
        env: { ...process.env, PATH: [process.env.PATH ?? "", ...FALLBACK_DIRS].join(delimiter), NO_COLOR: "1" },
      },
      (err, stdout, stderr) => {
        if (err) {
          const lines = String(stderr || err.message).split("\n").map((l) => l.trim());
          const detail = (lines.find((l) => l !== "" && l.toUpperCase() !== "ERROR") ?? err.message).slice(0, 160);
          reject(new Error((err as any).killed ? "timed out" : detail));
        } else resolve(stdout);
      },
    );
  });
}

async function fetchStatus(ref: MrRef): Promise<MrStatus> {
  try {
    if (ref.provider === "gitlab") {
      const glab = resolveBin("glab");
      if (!glab) throw new Error("glab not found");
      const out = await run(glab, [
        "api",
        "--hostname",
        ref.host,
        `projects/${encodeURIComponent(ref.project)}/merge_requests/${ref.number}`,
      ]);
      return mapGitlabMr(ref, JSON.parse(out));
    }
    const gh = resolveBin("gh");
    if (!gh) throw new Error("gh not found");
    const out = await run(gh, [
      "pr",
      "view",
      ref.url,
      "--json",
      "title,state,isDraft,url,headRefName,baseRefName,statusCheckRollup,mergeStateStatus,author,updatedAt",
    ]);
    return mapGithubPr(ref, JSON.parse(out));
  } catch (e) {
    return { ...ref, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Run `fn` over `items` with at most `limit` in flight, keeping order. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

function capped<V>(map: Map<string, V>, key: string, value: V) {
  map.delete(key);
  map.set(key, value);
  if (map.size > CACHE_CAP) map.delete(map.keys().next().value!);
}

export default async function plugin(bb: BbPluginApi) {
  bb.log.info("loaded");

  const statusCache = new Map<string, { at: number; value: MrStatus }>();
  const urlCache = new Map<string, MrRef[]>();
  // Concurrent callers (several panes, 60s pollers) share one in-flight fetch.
  const inflight = new Map<string, Promise<MrStatus>>();

  function cachedStatus(ref: MrRef, refresh: boolean): Promise<MrStatus> {
    const hit = statusCache.get(ref.url);
    if (!refresh && hit && Date.now() - hit.at < STATUS_TTL_MS) return Promise.resolve(hit.value);
    const pending = inflight.get(ref.url);
    if (pending) return pending;
    const p = fetchStatus(ref)
      .then((value) => {
        capped(statusCache, ref.url, { at: Date.now(), value });
        return value;
      })
      .finally(() => inflight.delete(ref.url));
    inflight.set(ref.url, p);
    return p;
  }

  async function threadRefs(threadId: string, refresh: boolean): Promise<MrRef[]> {
    const hit = urlCache.get(threadId);
    if (!refresh && hit) return hit;
    // The timeline view collapses tool output, so read the raw events that
    // carry content (user input, completed items incl. command output) page
    // by page. Each page is searched as JSON: JSON escapes (\n, \") end a
    // URL because `\` is not a URL character.
    const found = new Map<string, MrRef>();
    let afterSeq: string | undefined;
    for (let page = 0; page < MAX_EVENT_PAGES && found.size < MAX_MRS_PER_THREAD; page++) {
      const rows = await bb.sdk.threads.events.list({
        threadId,
        types: ["client/turn/requested", "item/completed"],
        limit: String(EVENT_PAGE_SIZE),
        ...(afterSeq === undefined ? {} : { afterSeq }),
      });
      for (const ref of extractMrRefs(JSON.stringify(rows))) {
        if (found.size < MAX_MRS_PER_THREAD && !found.has(ref.url)) found.set(ref.url, ref);
      }
      if (rows.length < EVENT_PAGE_SIZE) break;
      afterSeq = String(rows[rows.length - 1]!.seq);
    }
    const refs = [...found.values()];
    capped(urlCache, threadId, refs);
    return refs;
  }

  async function listThreadMergeRequests(threadId: string, refresh = false): Promise<MrStatus[]> {
    const refs = await threadRefs(threadId, refresh);
    return mapLimit(refs, CONCURRENCY, (ref) => cachedStatus(ref, refresh));
  }

  bb.rpc.register(rpcContract, {
    listThreadMergeRequests: ({ threadId, refresh }) => listThreadMergeRequests(threadId, refresh),
  });

  // A finished turn may have added links; drop the cached URL list.
  bb.events.on("thread.idle", ({ thread }) => {
    urlCache.delete(thread.id);
  });

  const usage = [
    "Usage:",
    "  bb session-mrs list [--thread <id>] [--refresh] [--json]",
    "  bb session-mrs status <url> [--json]",
  ].join("\n");

  bb.cli.register({
    name: "session-mrs",
    summary: "Show the merge/pull requests linked in a thread, with live status",
    commands: [
      {
        name: "list",
        summary: "List MRs/PRs linked in a thread (default: the current thread)",
        usage: "bb session-mrs list [--thread <id>] [--refresh] [--json]",
      },
      {
        name: "status",
        summary: "Show live status of one MR/PR URL",
        usage: "bb session-mrs status <url> [--json]",
      },
    ],
    async run(argv, ctx) {
      const json = argv.includes("--json");
      const args: string[] = [];
      let thread: string | undefined;
      let refresh = false;
      for (let i = 0; i < argv.length; i++) {
        const a = argv[i]!;
        if (a === "--json") continue;
        if (a === "--refresh") refresh = true;
        else if (a === "--thread") thread = argv[++i];
        else if (a.startsWith("--thread=")) thread = a.slice("--thread=".length);
        else args.push(a);
      }
      const [command, ...rest] = args;
      const out = (value: unknown, text: string) => ({ exitCode: 0, stdout: json ? JSON.stringify(value) : text });
      try {
        switch (command) {
          case undefined:
          case "help":
          case "--help":
            return { exitCode: 0, stdout: usage };
          case "list": {
            const threadId = thread ?? ctx.threadId ?? process.env.BB_THREAD_ID;
            if (!threadId || rest.length > 0 || !/^[A-Za-z0-9_-]{1,100}$/.test(threadId)) {
              return { exitCode: 1, stderr: `${usage}\n(pass --thread <id>)` };
            }
            const rows = await listThreadMergeRequests(threadId, refresh);
            return out(rows, formatTable(rows));
          }
          case "status": {
            const ref = rest.length === 1 ? parseMrUrl(rest[0]!) : null;
            if (!ref) return { exitCode: 1, stderr: `${usage}\n(expected one GitLab MR or GitHub PR URL)` };
            const row = await cachedStatus(ref, true);
            return out(row, formatTable([row]));
          }
        }
        return { exitCode: 1, stderr: usage };
      } catch (e) {
        return { exitCode: 1, stderr: e instanceof Error ? e.message : String(e) };
      }
    },
  });

  bb.onDispose(() => bb.log.info("disposed"));
}
