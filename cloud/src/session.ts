import type { Caller } from "./auth";
import { checkNotDeleted, HttpError, type LibraryEnv } from "./library";

/*
 * Keeping the app signed in. On Clerk's free plan a session ends 7 days after
 * sign-in, however much it's used, and nothing extends it. So the app, signed
 * in, asks here for a sign-in token (a one-use Clerk "ticket", good for a few
 * minutes) and signs in again with it: a new session, 7 more days, without the
 * person typing anything (src/state/cloud.ts renewSession).
 *
 * A session token alone isn't enough to get one: it lives a minute but travels
 * in WebSocket addresses, where it could be seen. The app also names its Clerk
 * client (the sign-in kept on the device, never in an address), and it must be
 * the client the session belongs to.
 *
 * Minting one needs the Clerk Secret Key (`wrangler secret put CLERK_SECRET_KEY`).
 * Without it the app is told renewal isn't available and stops asking.
 */

export interface SessionEnv extends LibraryEnv {
  CLERK_SECRET_KEY?: string;
}

const CLERK_API = "https://api.clerk.com/v1";
/** How long a ticket can be used for. The app uses it straight away. */
const TICKET_SECONDS = 5 * 60;
/** A session younger than this has nothing to gain from renewing (and a loop renewing one would show here). */
const MIN_AGE_MS = 30 * 60_000;

async function clerk<T>(env: SessionEnv, path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(CLERK_API + path, {
    ...init,
    headers: { Authorization: `Bearer ${env.CLERK_SECRET_KEY}`, "Content-Type": "application/json" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    console.error(JSON.stringify({ clerk: path.replace(/\/sess_[A-Za-z0-9]+/, "/:id"), status: res.status }));
    throw new HttpError(res.status === 404 ? 401 : 503, res.status === 404 ? "That session has ended. Sign in again." : "Couldn't reach Slopify's sign-in. Try again later.");
  }
  return (await res.json()) as T;
}

/**
 * A sign-in ticket for the caller, so the app can swap its session for a fresh
 * one. Only for the session the token belongs to, while it's still active, and
 * only from a token in the Authorization header (one in a URL, as WebSockets
 * send, may have been logged somewhere along the way).
 */
export async function renewalTicket(env: SessionEnv, caller: Caller, fromHeader: boolean, input: unknown) {
  if (!env.CLERK_SECRET_KEY) throw new HttpError(501, "Staying signed in isn't set up on this server.", "RENEW_UNAVAILABLE");
  if (!fromHeader || !caller.sessionId) throw new HttpError(401, "Sign in again.");
  const clientId = input && typeof input === "object" ? (input as Record<string, unknown>).clientId : null;
  if (typeof clientId !== "string" || !/^client_[A-Za-z0-9]{1,100}$/.test(clientId)) throw new HttpError(400, "Say which sign-in to renew.");
  await checkNotDeleted(env, caller.userId);
  const session = await clerk<{ user_id?: string; client_id?: string; status?: string; created_at?: number }>(env, `/sessions/${encodeURIComponent(caller.sessionId)}`);
  if (session.user_id !== caller.userId || session.client_id !== clientId || session.status !== "active") throw new HttpError(401, "That session has ended. Sign in again.");
  if (typeof session.created_at === "number" && Date.now() - session.created_at < MIN_AGE_MS) throw new HttpError(409, "This sign-in is still new.", "RENEW_TOO_SOON");
  const ticket = await clerk<{ token?: string }>(env, "/sign_in_tokens", {
    method: "POST",
    body: JSON.stringify({ user_id: caller.userId, expires_in_seconds: TICKET_SECONDS }),
  });
  if (!ticket.token) throw new HttpError(503, "Couldn't reach Slopify's sign-in. Try again later.");
  return { ticket: ticket.token };
}
