import { ShieldAlert } from "lucide-react";
import { TOOL_CATALOG } from "@/lib/tool-catalog";
import { Badge } from "@/components/ui/badge";
import { Card, CardHeader } from "@/components/ui/card";
import { getToolView } from "@/features/tool-views/registry";

/** Server Component: static facts about the four tools (lib/tool-catalog.ts). */
export function ToolCatalogPanel() {
  return (
    <Card>
      <CardHeader title="What this agent can do" titleId="tools-heading" description="Typed tools. Only one can write, and only after you approve." />
      <ul aria-labelledby="tools-heading" className="divide-y divide-border">
        {TOOL_CATALOG.map((tool) => {
          const Icon = getToolView(tool.name).icon;
          return (
            <li key={tool.name} className="flex gap-3 px-4 py-3">
              <Icon aria-hidden className="mt-0.5 size-4 shrink-0 text-muted" />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-ui font-semibold text-fg">{tool.name}</span>
                  {tool.access === "write" ? (
                    <Badge tone="warning">
                      <ShieldAlert aria-hidden />
                      Write · approval required
                    </Badge>
                  ) : (
                    <Badge tone="neutral">Read</Badge>
                  )}
                </div>
                <p className="mt-0.5 text-ui text-muted">{tool.description}</p>
              </div>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
