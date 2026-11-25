import type { NextRequest } from "next/server"; // type only: Node strips it, so the unit tests can import this file
import { readSessionToken, SESSION_COOKIE } from "../../../lib/auth.ts";
import { forwardApiRequest } from "../../../lib/api-proxy.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ path: string[] }> };

/** Reads the session cookie with Next's parser, the same one proxy.ts and the pages use. */
async function handle(request: NextRequest, context: RouteContext): Promise<Response> {
  const token = readSessionToken(request.cookies.get(SESSION_COOKIE)?.value);
  return forwardApiRequest(request, (await context.params).path, token);
}

export { handle as GET, handle as POST };
