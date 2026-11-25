import { RUN_EVENT_TYPES, type RunEvent } from "./api.ts";

export async function* readRunEvents(response: Response): AsyncGenerator<RunEvent> {
  if (!response.body) throw new Error("The run stream has no response body.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let dataLines: string[] = [];
  let eventId = "";
  let eventType = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        if (dataLines.length) throw new Error("The run stream ended with an incomplete event.");
        return;
      }
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const raw of lines) {
        const line = raw.replace(/\r$/, "");
        if (line.startsWith(":")) continue;
        if (line === "") {
          if (dataLines.length) {
            let event: RunEvent;
            try {
              event = JSON.parse(dataLines.join("\n"));
            } catch {
              throw new Error("The run stream contains a malformed event.");
            }
            if (!event || event.schema_version !== 1 || !Number.isSafeInteger(event.sequence) ||
                event.sequence < 1 || typeof event.run_id !== "string" || !RUN_EVENT_TYPES.includes(event.type) ||
                !event.payload || typeof event.payload !== "object" || Array.isArray(event.payload) ||
                typeof event.occurred_at !== "string" || Number.isNaN(Date.parse(event.occurred_at)) ||
                (eventId && String(event.sequence) !== eventId) || (eventType && event.type !== eventType)) {
              throw new Error("The run stream contains an invalid event.");
            }
            yield event;
          }
          dataLines = [];
          eventId = "";
          eventType = "";
          continue;
        }
        const separator = line.indexOf(":");
        const field = separator < 0 ? line : line.slice(0, separator);
        const value = separator < 0 ? "" : line.slice(separator + 1).replace(/^ /, "");
        if (field === "data") dataLines.push(value);
        else if (field === "id") eventId = value;
        else if (field === "event") eventType = value;
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
