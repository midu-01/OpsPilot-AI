import { memo } from "react";
import { UserRound } from "lucide-react";
import { formatDateTime } from "@/lib/format";
import { TraceStep, type StepPosition } from "./trace-step";

interface GoalItemProps extends StepPosition {
  goal: string;
  createdAt: string;
  timeZone: string;
}

export const GoalItem = memo(function GoalItem({ goal, createdAt, timeZone, ...position }: GoalItemProps) {
  return (
    <TraceStep id="goal" icon={UserRound} tone="neutral" title="Goal" meta={`Submitted ${formatDateTime(createdAt, timeZone)}`} {...position}>
      <p className="text-sm leading-relaxed break-words whitespace-pre-wrap text-fg">{goal}</p>
    </TraceStep>
  );
});
