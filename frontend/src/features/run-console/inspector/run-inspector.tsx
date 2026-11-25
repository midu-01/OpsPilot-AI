"use client";

import { Activity, Cpu, Info } from "lucide-react";
import type { RunState } from "@/lib/run-events";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { EventsTab } from "./events-tab";
import { ModelCallsTab } from "./model-calls-tab";
import { OverviewTab } from "./overview-tab";

interface RunInspectorProps {
  state: RunState;
  live: boolean;
  /** Called when the Model calls tab opens during a live run (usage only arrives in snapshots). */
  onOpenModelCalls: () => void;
}

/** Details beside the trace: the run's metadata, each model call, and the raw event log. */
export function RunInspector({ state, live, onOpenModelCalls }: RunInspectorProps) {
  return (
    <Tabs
      defaultValue="overview"
      onValueChange={(value) => {
        if (value === "model-calls" && live) onOpenModelCalls();
      }}
      className="flex min-h-0 flex-1 flex-col"
    >
      <TabsList aria-label="Run inspector" className="shrink-0 px-2">
        <TabsTrigger value="overview">
          <Info aria-hidden />
          Overview
        </TabsTrigger>
        <TabsTrigger value="model-calls">
          <Cpu aria-hidden />
          Model calls
        </TabsTrigger>
        <TabsTrigger value="events">
          <Activity aria-hidden />
          Events
          <span className="rounded bg-surface-2 px-1 text-[11px] tabular-nums text-muted">{state.events.length}</span>
        </TabsTrigger>
      </TabsList>
      <TabsContent value="overview" className="min-h-0 flex-1 overflow-y-auto">
        <OverviewTab state={state} />
      </TabsContent>
      <TabsContent value="model-calls" className="min-h-0 flex-1 overflow-y-auto">
        <ModelCallsTab calls={state.model_calls} live={live} />
      </TabsContent>
      <TabsContent value="events" className="flex min-h-0 flex-1 flex-col data-[state=inactive]:hidden">
        <EventsTab events={state.events} timeZone={state.business_timezone} />
      </TabsContent>
    </Tabs>
  );
}
