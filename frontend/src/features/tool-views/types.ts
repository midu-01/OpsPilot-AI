import type { ComponentType } from "react";
import type { LucideIcon } from "lucide-react";
import type { ToolCallSnapshot } from "@/lib/api";

export interface ToolViewProps {
  call: ToolCallSnapshot;
  /** `data` of a successful result. Views must narrow it and fall back to JSON. */
  data: unknown;
  /** The run's business timezone, for dates. */
  timeZone: string;
}

export interface ToolViewDefinition {
  icon: LucideIcon;
  /** Renders a successful result in a form that suits the tool. */
  ResultView: ComponentType<ToolViewProps>;
}
