const API_PATH = /^(?:runs(?:\/[^/]+(?:\/(?:stream|approve|stop))?)?|health\/(?:live|ready))$/;

export async function forwardApiRequest(request: Request, path: string[]): Promise<Response> {
  if (path.some((part) => !part || part === "." || part === ".." || /[\\/%?#\x00]/.test(part)) ||
      !API_PATH.test(path.join("/"))) {
    return Response.json({ detail: "API route not found" }, { status: 404 });
  }

  const streaming = request.method === "GET" && path.at(-1) === "stream";
  const headers = new Headers();
  for (const name of ["accept", "content-type", "last-event-id"]) {
    const value = request.headers.get(name);
    if (value !== null) headers.set(name, value);
  }

  try {
    const base = process.env.API_INTERNAL_URL ?? "http://127.0.0.1:8000";
    const target = new URL(path.map(encodeURIComponent).join("/"), `${base.replace(/\/+$/, "")}/`);
    target.search = new URL(request.url).search;
    const signal = streaming
      ? request.signal
      : AbortSignal.any([request.signal, AbortSignal.timeout(15000)]);
    const upstream = await fetch(target, {
      method: request.method,
      headers,
      body: request.method === "GET" || request.method === "HEAD" ? undefined : await request.text(),
      signal,
      cache: "no-store",
      redirect: "manual",
    });

    const responseHeaders = new Headers({ "Cache-Control": "no-store" });
    const contentType = upstream.headers.get("content-type");
    if (contentType) responseHeaders.set("Content-Type", contentType);
    if (streaming) {
      responseHeaders.set("Cache-Control", "no-cache, no-transform");
      responseHeaders.set("X-Accel-Buffering", "no");
    }

    // Pass the stream through without collecting it; browser disconnect cancels the upstream reader.
    return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
  } catch (error) {
    if (request.signal.aborted) throw error;
    return Response.json(
      { detail: "Could not reach the backend. Check that the backend service is running, then try again." },
      { status: 502, headers: { "Cache-Control": "no-store" } },
    );
  }
}
