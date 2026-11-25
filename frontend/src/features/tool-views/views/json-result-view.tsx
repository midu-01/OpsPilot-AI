import { JsonBlock } from "../json-block";
import type { ToolViewProps } from "../types";

/** Fallback for tools without a dedicated view. */
export function JsonResultView({ data }: ToolViewProps) {
  return <JsonBlock value={data} label="result" />;
}
