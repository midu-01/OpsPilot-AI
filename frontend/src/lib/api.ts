export async function checkReadiness(origin: string, cancel?: AbortSignal): Promise<boolean> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (cancel?.aborted) return false;
  cancel?.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(abort, 4000);

  try {
    const response = await fetch(new URL("/health/ready", origin), {
      cache: "no-store",
      signal: controller.signal,
    });
    return response.ok && (await response.json()).status === "ready";
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
    cancel?.removeEventListener("abort", abort);
  }
}
