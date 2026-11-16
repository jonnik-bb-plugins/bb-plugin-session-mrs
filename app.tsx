// bb-plugin-session-mrs — frontend: the "Merge requests" section of the thread
// context card and of the Info tab. Both render the same RPC-backed list.
import { useCallback, useEffect, useState } from "react";
import type { MouseEvent } from "react";
import {
  definePluginApp,
  experimental_InfoList as InfoList,
  experimental_InfoListRow as InfoListRow,
  experimental_InfoSection as InfoSection,
  experimental_THREAD_INFO_SECTION_GROUPS as SECTION_GROUPS,
  experimental_ThreadContextCardRow as ThreadContextCardRow,
  useBbNavigate,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

type Mr = Awaited<
  ReturnType<ReturnType<typeof useRpc<typeof rpcContract>>["call"]>
>[number];

const POLL_MS = 60_000;

const stateLabel = (mr: Mr) =>
  mr.error
    ? "Status unavailable"
    : mr.state === "merged"
      ? "Merged"
      : mr.state === "closed"
        ? "Closed"
        : mr.draft
          ? "Draft"
          : "Open";

const stateClass = (mr: Mr) =>
  mr.error
    ? "text-muted-foreground"
    : mr.state === "closed"
    ? "text-destructive"
    : mr.state === "merged"
      ? "text-purple-600 dark:text-purple-400"
      : mr.draft
        ? "text-muted-foreground"
        : "text-emerald-600 dark:text-emerald-400";

const PIPELINE = {
  success: { symbol: "✓", label: "Pipeline passed", cls: "text-emerald-600 dark:text-emerald-400" },
  failure: { symbol: "✗", label: "Pipeline failed", cls: "text-destructive" },
  pending: { symbol: "…", label: "Pipeline running", cls: "text-muted-foreground" },
} as const;

/** Fetches on mount, on threadId change, and every minute while mounted. */
function useThreadMrs(threadId: string) {
  const rpc = useRpc<typeof rpcContract>();
  const [mrs, setMrs] = useState<Mr[]>([]);
  const [loading, setLoading] = useState(false);

  const load = useCallback(
    async (refresh: boolean, isCurrent: () => boolean = () => true) => {
      setLoading(true);
      try {
        const rows = await rpc.call("listThreadMergeRequests", { threadId, refresh });
        if (isCurrent()) setMrs(rows);
      } catch (cause) {
        console.warn("session-mrs: failed to load merge requests", cause);
      } finally {
        if (isCurrent()) setLoading(false);
      }
    },
    [rpc, threadId],
  );

  useEffect(() => {
    let current = true;
    setMrs([]);
    void load(false, () => current);
    const timer = setInterval(() => void load(false, () => current), POLL_MS);
    return () => {
      current = false;
      clearInterval(timer);
    };
  }, [load]);

  return { mrs, loading, refresh: () => void load(true) };
}

function Chips({ mr }: { mr: Mr }) {
  const p = mr.error ? undefined : mr.pipeline && mr.pipeline !== "none" ? PIPELINE[mr.pipeline] : undefined;
  return (
    <span className="flex shrink-0 items-center gap-1.5 text-xs">
      <span className={cn("font-medium", stateClass(mr))}>{stateLabel(mr)}</span>
      {p ? (
        <span className={p.cls} title={p.label} aria-label={p.label}>
          {p.symbol}
        </span>
      ) : null}
    </span>
  );
}

const tooltip = (mr: Mr) =>
  [
    mr.title,
    mr.error ? `Failed to load status: ${mr.error}` : null,
    mr.sourceBranch && mr.targetBranch ? `${mr.sourceBranch} → ${mr.targetBranch}` : null,
    mr.author ? `by ${mr.author}` : null,
    mr.mergeStatus ? `merge status: ${mr.mergeStatus}` : null,
  ]
    .filter(Boolean)
    .join("\n") || mr.url;

function RefreshButton({ loading, onClick }: { loading: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      title="Refresh merge requests"
      aria-label="Refresh merge requests"
      disabled={loading}
      className="inline-flex size-5 cursor-pointer items-center justify-center rounded text-muted-foreground hover:text-foreground disabled:opacity-50"
      onClick={(event: MouseEvent) => {
        event.stopPropagation();
        onClick();
      }}
    >
      <Icon name="ArrowReloadHorizontal" className={cn("size-3.5", loading && "animate-spin")} />
    </button>
  );
}

/** `ref` then the title on one line; the host row truncates the whole name. */
function RefTitle({ mr }: { mr: Mr }) {
  return (
    <>
      <span className="font-medium">{mr.ref}</span>
      {mr.title ? <span className="text-muted-foreground"> {mr.title}</span> : null}
    </>
  );
}

function CardSection({ threadId }: { threadId: string }) {
  const { mrs, loading, refresh } = useThreadMrs(threadId);
  const navigate = useBbNavigate();
  if (mrs.length === 0) return null;
  return (
    <>
      {mrs.map((mr) => (
        <ThreadContextCardRow
          key={mr.url}
          icon="GitMerge"
          label={
            <span className="block truncate">
              <RefTitle mr={mr} />
            </span>
          }
          title={tooltip(mr)}
          trailing={<Chips mr={mr} />}
          action={<RefreshButton loading={loading} onClick={refresh} />}
          onClick={() => navigate.openUrl(mr.webUrl ?? mr.url)}
        />
      ))}
    </>
  );
}

function InfoMrs({ threadId }: { threadId: string }) {
  const { mrs, loading, refresh } = useThreadMrs(threadId);
  const navigate = useBbNavigate();
  if (mrs.length === 0) return null;
  return (
    <InfoSection
      label="Merge requests"
      count={mrs.length}
      accessory={<RefreshButton loading={loading} onClick={refresh} />}
    >
      <InfoList
        items={mrs}
        getKey={(mr) => mr.url}
        limit={5}
        renderItem={(mr) => (
          <InfoListRow
            leading={<Icon name="GitMerge" className="size-3" />}
            name={<RefTitle mr={mr} />}
            title={tooltip(mr)}
            trailing={<Chips mr={mr} />}
            onSelect={() => navigate.openUrl(mr.webUrl ?? mr.url)}
          />
        )}
      />
    </InfoSection>
  );
}

export default definePluginApp((app) => {
  app.slots.experimental_threadContextCardSection({
    id: "merge-requests",
    title: "Merge requests",
    group: SECTION_GROUPS.related,
    order: 10,
    component: CardSection,
  });
  app.slots.experimental_threadInfoSection({
    id: "merge-requests",
    group: SECTION_GROUPS.related,
    order: 10,
    component: InfoMrs,
  });
});
