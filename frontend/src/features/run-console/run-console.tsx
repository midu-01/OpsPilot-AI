"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, PanelRight } from "lucide-react";
import type { RunSnapshot } from "@/lib/api";
import type { RunState } from "@/lib/run-events";
import { describeActivity, describeAnnouncement } from "@/lib/activity";
import { isTerminalStatus } from "@/lib/status";
import { buildTimeline, isTextStreaming } from "@/lib/timeline";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/sheet";
import { useFollowScroll } from "@/hooks/use-follow-scroll";
import { BudgetMeters } from "./budget-meters";
import { RunInspector } from "./inspector/run-inspector";
import { RunHeader } from "./run-header";
import { StatusBar } from "./status-bar";
import { RunTrace } from "./trace/run-trace";
import { useRunStream } from "./use-run-stream";

const APPROVAL_TITLE_PREFIX = "Approval needed · ";

/**
 * Prefixes the tab title while the run waits for approval. Next.js streams page
 * metadata, so its <title> can arrive after this effect; the observer re-applies
 * the prefix whenever the title changes.
 */
function useApprovalTabTitle(needsApproval: boolean) {
  useEffect(() => {
    if (!needsApproval) return;
    const applyPrefix = () => {
      if (!document.title.startsWith(APPROVAL_TITLE_PREFIX)) document.title = APPROVAL_TITLE_PREFIX + document.title;
    };
    applyPrefix();
    const observer = new MutationObserver(applyPrefix);
    observer.observe(document.head, { childList: true, subtree: true, characterData: true });
    return () => {
      observer.disconnect();
      if (document.title.startsWith(APPROVAL_TITLE_PREFIX)) document.title = document.title.slice(APPROVAL_TITLE_PREFIX.length);
    };
  }, [needsApproval]);
}

/** Polite announcements for screen readers (approval needed, decision recorded, stopping, finished). */
function LiveAnnouncement({ text }: { text: string }) {
  return (
    <p className="sr-only" aria-live="polite" aria-atomic="true">
      {text}
    </p>
  );
}

/**
 * The live run console. The server page passes the snapshot it fetched; from here on
 * every change comes from the SSE stream (useRunStream) or from a fresh snapshot.
 * Everything below this component depends on live state, so it is one client island.
 */
export function RunConsole({ initialSnapshot }: { initialSnapshot: RunSnapshot }) {
  const { state, connection, refresh, markStopping } = useRunStream(initialSnapshot);
  const [notice, setNotice] = useState<string | null>(null);
  const traceRef = useRef<HTMLDivElement>(null);
  // After an action, keyboard focus moves to its result in the trace once it arrives.
  const focusWhenReady = useRef<{ elementId: string; ready: (state: RunState) => boolean } | null>(null);

  const items = useMemo(() => buildTimeline(state), [state]);
  const activity = describeActivity(state);
  const live = !isTerminalStatus(state.status);
  const { following, jumpToLatest } = useFollowScroll(traceRef, live);
  useApprovalTabTitle(state.pending_approval !== null);

  useEffect(() => {
    const target = focusWhenReady.current;
    if (!target || !target.ready(state)) return;
    focusWhenReady.current = null;
    document.getElementById(target.elementId)?.focus({ preventScroll: true });
  }, [state]);

  // After a command, load a snapshot too: the stream normally delivers the result,
  // but this keeps the page correct if the stream is reconnecting.
  const refreshQuietly = useCallback(() => {
    refresh().catch(() => undefined);
  }, [refresh]);

  const handleDecided = useCallback(
    (approvalId: string) => {
      focusWhenReady.current = {
        elementId: `approval-${approvalId}`,
        ready: (next) => next.approvals.some((approval) => approval.id === approvalId && approval.status !== "pending"),
      };
      refreshQuietly();
    },
    [refreshQuietly],
  );

  const handleConflict = useCallback(
    (detail: string) => {
      setNotice(`${detail} The trace now shows the run's current state.`);
      refreshQuietly();
    },
    [refreshQuietly],
  );

  const handleStopped = useCallback(() => {
    focusWhenReady.current = { elementId: "outcome", ready: (next) => isTerminalStatus(next.status) };
    markStopping();
    refreshQuietly();
  }, [markStopping, refreshQuietly]);

  function jumpAndFocus() {
    jumpToLatest();
    const feed = traceRef.current?.querySelector('[role="feed"]');
    (feed?.lastElementChild as HTMLElement | null)?.focus({ preventScroll: true });
  }

  const announcement = describeAnnouncement(state);
  const inspectorSheet = (
    <Sheet
      title="Run inspector"
      description="Overview, model calls and the event log."
      trigger={
        <Button size="sm" variant="secondary" className="xl:hidden">
          <PanelRight aria-hidden />
          Inspect
        </Button>
      }
    >
      <div className="flex h-[70dvh] flex-col">
        <RunInspector state={state} live={live} onOpenModelCalls={refreshQuietly} />
      </div>
      {/* The dialog hides the rest of the page from screen readers, so it carries its own live region. */}
      <LiveAnnouncement text={announcement} />
    </Sheet>
  );

  return (
    <div className="space-y-5">
      <RunHeader
        id={state.id}
        goal={state.goal}
        provider={state.provider}
        model={state.model}
        referenceTime={state.reference_time}
        timeZone={state.business_timezone}
        createdAt={state.created_at}
      />
      <StatusBar state={state} activity={activity} connection={connection} onStopped={handleStopped} actions={inspectorSheet} />

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_24rem]">
        <div className="min-w-0 space-y-5">
          {notice ? (
            <Alert
              tone="warning"
              role="alert"
              title="Your decision was not recorded"
              action={
                <Button size="sm" onClick={() => setNotice(null)}>
                  Dismiss
                </Button>
              }
            >
              {notice}
            </Alert>
          ) : null}
          <BudgetMeters state={state} />
          <div ref={traceRef} className="pt-2">
            <RunTrace
              state={state}
              items={items}
              busy={isTextStreaming(state)}
              live={live}
              onDecided={handleDecided}
              onConflict={handleConflict}
            />
          </div>
        </div>

        {/* Wide screens: the inspector stays beside the trace, below the sticky status bar. */}
        <aside aria-label="Run inspector" className="hidden xl:block">
          <div className="sticky top-[7.75rem] flex max-h-[calc(100dvh-8.75rem)] flex-col overflow-hidden rounded-lg border border-border bg-surface">
            <RunInspector state={state} live={live} onOpenModelCalls={refreshQuietly} />
          </div>
        </aside>
      </div>

      <LiveAnnouncement text={announcement} />

      {live && !following ? (
        <div className="fixed right-4 bottom-4 z-30 sm:right-6 sm:bottom-6">
          <Button variant="secondary" className="shadow-lg" onClick={jumpAndFocus}>
            <ArrowDown aria-hidden />
            Jump to latest
          </Button>
        </div>
      ) : null}
    </div>
  );
}
