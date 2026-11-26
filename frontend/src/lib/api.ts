export type RunStatus =
  | "queued"
  | "running"
  | "awaiting_approval"
  | "completed"
  | "failed"
  | "cancelling"
  | "cancelled";

export type ApprovalDecision = "approve" | "reject";

export type ApprovalStatus = "pending" | "approved" | "rejected" | "cancelled";

export const RUN_EVENT_TYPES = [
  "run.queued", "run.started", "message.delta", "message.completed",
  "tool.requested", "tool.started", "tool.completed", "tool.failed",
  "approval.required", "approval.decided", "usage.updated",
  "run.completed", "run.failed", "run.cancelled",
] as const;

export type EventType = (typeof RUN_EVENT_TYPES)[number];

export interface RunEvent {
  schema_version: 1;
  run_id: string;
  sequence: number;
  type: EventType;
  occurred_at: string;
  payload: Record<string, unknown>;
}

export interface ToolError {
  code: string;
  message: string;
}

export interface ToolSuccess {
  ok: true;
  data: unknown;
}

export interface ToolFailure {
  ok: false;
  error: ToolError;
}

export type ToolResult = ToolSuccess | ToolFailure;

export interface ToolCallSnapshot {
  id: string;
  provider_call_id: string;
  name: string;
  arguments: Record<string, unknown>;
  status: string;
  result?: ToolResult | string | null;
  error?: string | null;
  started_at?: string | null;
  completed_at?: string | null;
}

export interface MessageSnapshot {
  id: string;
  index: number;
  role: "system" | "user" | "assistant" | "tool";
  text?: string | null;
  tool_calls: ToolCallSnapshot[];
  created_at: string;
}

export interface ApprovalSnapshot {
  id: string;
  tool_call_id: string;
  tool_name: string;
  proposed_arguments: Record<string, unknown>;
  status: ApprovalStatus;
  reason?: string | null;
  decided_at?: string | null;
}

export interface ModelAttemptSnapshot {
  id: string;
  model: string;
  status: string;
  input_tokens?: number | null;
  output_tokens?: number | null;
  cached_tokens?: number | null;
  usage_complete: boolean;
  pricing_snapshot?: Record<string, unknown> | null;
  estimated_cost_usd?: string | null;
}

export interface RunSummary {
  id: string;
  goal: string;
  status: RunStatus;
  step_count: number;
  total_tokens: number;
  token_usage_complete?: boolean | null;
  cost_is_upper_bound?: boolean;
  estimated_cost_usd?: string | null;
  duration_ms?: number | null;
  created_at: string;
  updated_at: string;
}

export interface RunSnapshot {
  id: string;
  goal: string;
  status: RunStatus;
  provider: string;
  model: string;
  reference_time: string;
  business_timezone: string;
  step_count: number;
  tool_call_count: number;
  total_tokens: number;
  token_usage_complete?: boolean | null;
  cost_is_upper_bound?: boolean;
  estimated_cost_usd?: string | null;
  active_elapsed_ms: number;
  max_agent_steps: number;
  max_tool_calls: number;
  model_calls: ModelAttemptSnapshot[];
  messages: MessageSnapshot[];
  approvals: ApprovalSnapshot[];
  events: RunEvent[];
  pending_approval?: ApprovalSnapshot | null;
  snapshot_cursor: number;
  created_at: string;
  updated_at: string;
}

export interface PaginatedRuns {
  items: RunSummary[];
  total: number;
  page: number;
  page_size: number;
}

/** GET /auth/me. Never contains password or token hashes. */
export interface SessionUser {
  id: string;
  email: string;
  display_name: string;
}

/** FastAPI issues secrets.token_urlsafe(32) session tokens (base64url). Anything else is not ours. */
export const SESSION_TOKEN = /^[A-Za-z0-9_-]{16,256}$/;

/** POST /auth/login. Only the Next.js server sees `access_token`; it goes into an HttpOnly cookie. */
export interface LoginResponse {
  access_token: string;
  token_type: string;
  expires_at: string;
  user: SessionUser;
}

/** For calls the Next.js server makes on the user's behalf: it adds `Authorization: Bearer <token>`. */
export interface RequestOptions {
  signal?: AbortSignal;
  headers?: Record<string, string>;
}

export class ApiError extends Error {
  status: number;
  detail?: string;

  constructor(status: number, message: string, detail?: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.detail = detail;
  }
}

/**
 * The browser always calls the same-origin /api proxy: it is the only path that turns the
 * HttpOnly session cookie into a bearer token. Server code calls FastAPI directly.
 */
export function getApiBaseUrl(): string {
  if (typeof window !== "undefined") return `${window.location.origin}/api`;
  return process.env.API_INTERNAL_URL ?? "http://127.0.0.1:8000";
}

function apiUrl(path: string, base = getApiBaseUrl()): URL {
  return new URL(path.replace(/^\/+/, ""), `${base.replace(/\/+$/, "")}/`);
}

async function request<T>(
  path: string,
  options: Omit<RequestInit, "headers"> & { baseUrl?: string; headers?: Record<string, string> } = {}
): Promise<T> {
  const { baseUrl = getApiBaseUrl(), ...fetchOptions } = options;
  const url = apiUrl(path, baseUrl).toString();

  let response: Response;
  try {
    response = await fetch(url, {
      ...fetchOptions,
      headers: {
        "Content-Type": "application/json",
        ...fetchOptions.headers,
      },
    });
  } catch (err: unknown) {
    if (fetchOptions.signal?.aborted || (err instanceof Error && err.name === "AbortError")) throw err;
    const detail = "Could not reach the API. Check that the frontend and backend services are running, then try again.";
    throw new ApiError(0, detail, detail);
  }

  if (!response.ok) {
    const text = await response.text();
    let detail: string | undefined = text || undefined;
    try {
      const data = JSON.parse(text);
      detail = typeof data?.detail === "string" ? data.detail : JSON.stringify(data?.detail);
    } catch {
      // Preserve text errors rather than trying to read an already-consumed body.
    }
    throw new ApiError(response.status, `Request failed (${response.status}): ${detail || response.statusText}`, detail);
  }

  if (response.status === 204) return undefined as T; // e.g. POST /auth/logout

  try {
    return (await response.json()) as T;
  } catch {
    throw new ApiError(502, "The backend returned a response that is not JSON.");
  }
}

const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Path for one run. IDs come from the URL, so anything that is not a UUID is rejected
 * here with the same 422 the backend would send (this also stops "." and ".." segments).
 */
function runPath(runId: string, suffix = ""): string {
  if (!RUN_ID.test(runId)) throw new ApiError(422, "Invalid run ID", "Invalid run ID");
  return `/runs/${runId}${suffix}`;
}

export async function createRun(goal: string, options?: { signal?: AbortSignal }): Promise<RunSummary> {
  return request<RunSummary>("/runs", {
    method: "POST",
    body: JSON.stringify({ goal }),
    signal: options?.signal,
  });
}

export async function listRuns(page = 1, pageSize = 20, options?: RequestOptions): Promise<PaginatedRuns> {
  return request<PaginatedRuns>(`/runs?page=${page}&page_size=${pageSize}`, {
    method: "GET",
    signal: options?.signal,
    headers: options?.headers,
  });
}

export async function getRun(runId: string, options?: RequestOptions): Promise<RunSnapshot> {
  const snapshot = await request<RunSnapshot>(runPath(runId), {
    method: "GET",
    signal: options?.signal,
    headers: options?.headers,
  });
  // The console builds its state from these fields; fail clearly if they are missing.
  if (!Array.isArray(snapshot?.messages) || !Array.isArray(snapshot.events) || !Number.isSafeInteger(snapshot.snapshot_cursor)) {
    throw new ApiError(502, "The backend returned an unexpected run snapshot.");
  }
  return snapshot;
}

export async function decideApproval(
  runId: string,
  approvalId: string,
  decision: ApprovalDecision,
  reason?: string | null,
  options?: { signal?: AbortSignal }
): Promise<RunSummary> {
  return request<RunSummary>(runPath(runId, "/approve"), {
    method: "POST",
    body: JSON.stringify({
      approval_id: approvalId,
      decision,
      ...(reason ? { reason } : {}),
    }),
    signal: options?.signal,
  });
}

export async function stopRun(runId: string, options?: { signal?: AbortSignal }): Promise<RunSummary> {
  return request<RunSummary>(runPath(runId, "/stop"), {
    method: "POST",
    signal: options?.signal,
  });
}

function isSessionUser(value: unknown): value is SessionUser {
  const user = value as Partial<SessionUser> | null;
  return typeof user?.id === "string" && typeof user.email === "string" && typeof user.display_name === "string";
}

/**
 * Sign-in, sign-out and "who am I" are called by the Next.js server only (Server Actions and
 * server/session.ts), straight to API_INTERNAL_URL. The browser's /api proxy does not expose
 * /auth, so the token never passes through browser JavaScript.
 */
export async function login(email: string, password: string, options?: { signal?: AbortSignal }): Promise<LoginResponse> {
  const session = await request<LoginResponse>("/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password }),
    signal: options?.signal,
  });
  // The cookie must hold a token the console will read back, or the user would look signed out.
  const valid =
    typeof session?.access_token === "string" && SESSION_TOKEN.test(session.access_token) &&
    Number.isFinite(Date.parse(session.expires_at)) && isSessionUser(session.user);
  if (!valid) throw new ApiError(502, "The backend returned an unexpected sign-in response.");
  return session;
}

/** POST /auth/logout answers 204 and revokes the bearer token it was sent. */
export async function logout(options?: RequestOptions): Promise<void> {
  await request<void>("/auth/logout", { method: "POST", signal: options?.signal, headers: options?.headers });
}

export async function getMe(options?: RequestOptions): Promise<SessionUser> {
  const user = await request<unknown>("/auth/me", { method: "GET", signal: options?.signal, headers: options?.headers });
  if (!isSessionUser(user)) throw new ApiError(502, "The backend returned an unexpected user.");
  return user;
}

/**
 * The run's live stream: a WebSocket on the console's own origin (wss: when the page is on
 * HTTPS). The browser sends the session cookie with the handshake, and proxy.ts forwards it
 * to FastAPI as a bearer token. `after` is the last event the page already has.
 */
export function getStreamUrl(runId: string, after?: number): string {
  const url = apiUrl(runPath(runId, "/stream"));
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  if (after !== undefined && after > 0) {
    url.searchParams.set("after", after.toString());
  }
  return url.toString();
}

export interface Readiness {
  /** "unreachable" means no HTTP answer at all (network error or timeout). */
  status: "ready" | "unavailable" | "unreachable";
  /** Per-dependency details reported by GET /health/ready, e.g. { database: "connected" }. */
  details: Record<string, string>;
}

const READINESS_TIMEOUT_MS = 4000;

export async function getReadiness(origin: string, cancel?: AbortSignal): Promise<Readiness> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (cancel?.aborted) return { status: "unreachable", details: {} };
  cancel?.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(abort, READINESS_TIMEOUT_MS);

  try {
    const response = await fetch(apiUrl("/health/ready", origin), {
      cache: "no-store",
      signal: controller.signal,
    });
    const body: unknown = await response.json().catch(() => null);
    const record = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const details: Record<string, string> = {};
    if (record.details && typeof record.details === "object") {
      for (const [key, value] of Object.entries(record.details)) {
        if (typeof value === "string") details[key] = value;
      }
    }
    const ready = response.ok && record.status === "ready";
    return { status: ready ? "ready" : "unavailable", details };
  } catch {
    return { status: "unreachable", details: {} };
  } finally {
    clearTimeout(timeout);
    cancel?.removeEventListener("abort", abort);
  }
}

export async function checkReadiness(origin: string, cancel?: AbortSignal): Promise<boolean> {
  return (await getReadiness(origin, cancel)).status === "ready";
}

