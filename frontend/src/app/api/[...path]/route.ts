import { forwardApiRequest } from "../../../lib/api-proxy.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ path: string[] }> };

async function handle(request: Request, context: RouteContext): Promise<Response> {
  return forwardApiRequest(request, (await context.params).path);
}

export { handle as GET, handle as POST };
