import { readFileSync } from "node:fs";
import http from "node:http";
import { expect, test, type Page, type WebSocket } from "@playwright/test";
import { approvalCard, startPreset, USERS } from "./helpers";

/** Starts a run that pauses for approval, so its stream stays open; resolves with its id. */
async function pausedRun(page: Page): Promise<string> {
  const runUrl = await startPreset(page, /Refund ORD-1001, then reject it/);
  await expect(approvalCard(page)).toBeVisible({ timeout: 20_000 });
  return runUrl.split("/").at(-1)!;
}

async function stopRun(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await page.getByRole("group", { name: "Confirm stop" }).getByRole("button", { name: "Stop run" }).click();
  await expect(page.getByRole("heading", { name: "Run stopped" })).toBeVisible({ timeout: 20_000 });
}

test("the console follows a run over a WebSocket on its own origin", async ({ page, baseURL }) => {
  const sockets: WebSocket[] = [];
  const messages: { type: string }[] = [];
  page.on("websocket", (socket) => {
    if (!socket.url().includes("/api/runs/")) return;
    sockets.push(socket);
    socket.on("framereceived", ({ payload }) => messages.push(JSON.parse(String(payload))));
  });

  await pausedRun(page);
  await expect(page.getByText("Live", { exact: true })).toBeVisible();

  expect(sockets).toHaveLength(1);
  expect(sockets[0].url()).toMatch(new RegExp(`^ws://${new URL(baseURL!).host}/api/runs/[0-9a-f-]{36}/stream`));
  expect(messages[0]).toEqual({ type: "stream.ready" });
  expect(messages.map((message) => message.type)).toContain("approval.required");

  // Stop is an HTTP POST; its effect arrives on the open socket, which the server then closes.
  await stopRun(page);
  expect(messages.map((message) => message.type)).toContain("run.cancelled");
  await expect.poll(() => sockets[0].isClosed()).toBe(true);
  await expect(page.getByText("Stream complete", { exact: true })).toBeVisible();
});

/** Alex's session cookie, as saved by auth.setup.ts. */
function sessionCookie(): string {
  const state = JSON.parse(readFileSync(USERS.alex.storageState, "utf8")) as { cookies: { name: string; value: string }[] };
  const cookie = state.cookies.find(({ name }) => name === "opspilot_session");
  if (!cookie) throw new Error("Alex's saved browser state has no session cookie");
  return `${cookie.name}=${cookie.value}`;
}

/**
 * A WebSocket handshake sent by hand, with headers a page could never forge. Resolves with the
 * HTTP status (101 once upgraded), "refused" when the console closed the connection, or "hung"
 * when nothing came back for 5 s: a socket left open with no answer.
 */
function handshake(url: URL, headers: Record<string, string>): Promise<number | "refused" | "hung"> {
  return new Promise((resolve) => {
    const request = http.request(url, {
      headers: {
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
        ...headers,
      },
    });
    request.setTimeout(5_000, () => {
      resolve("hung");
      request.destroy();
    });
    request.on("upgrade", (response, socket) => {
      socket.destroy();
      resolve(response.statusCode ?? 0);
    });
    request.on("response", (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    request.on("error", () => resolve("refused"));
    request.end();
  });
}

test("the console refuses a stream handshake from another origin or without a session", async ({ page, baseURL }) => {
  const runId = await pausedRun(page);
  const url = new URL(`/api/runs/${runId}/stream`, baseURL);
  const ownOrigin = new URL(baseURL!).origin;
  const cookie = sessionCookie();

  expect(await handshake(url, { Origin: ownOrigin, Cookie: cookie })).toBe(101);
  // Cross-site WebSocket hijacking: another site's page, with the user's cookie attached.
  expect(await handshake(url, { Origin: "https://evil.example", Cookie: cookie })).toBe("refused");
  expect(await handshake(url, { Origin: ownOrigin })).toBe("refused");
  // A path the console never sends gets an answer too, not a socket left open.
  expect(await handshake(new URL("/api/runs/not-a-run/stream", baseURL), { Origin: ownOrigin })).toBe("refused");

  await stopRun(page);
});
