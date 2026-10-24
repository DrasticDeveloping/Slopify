import { useSyncExternalStore } from "react";
import { thisDevice } from "../lib/native";
import { toast } from "./actions";
import { checkForUpdates } from "./desktop";
import { flushPersist, getState, setState } from "./store";

/*
 * Slopify's online service (cloud/): accounts, the library following your
 * account, and Listen Along. Sign-in is Clerk's; the components in
 * src/components/CloudAccount.tsx connect it here. Where the service lives and
 * which Clerk app signs in come from release.config.json (cloudUrl,
 * clerkPublishableKey) when the app is built; without them, none of this shows.
 */

declare const __SLOPIFY_CLOUD__: { url: string; clerkPublishableKey: string };

export const cloudConfig = {
  url: __SLOPIFY_CLOUD__.url.replace(/\/+$/, ""),
  clerkPublishableKey: __SLOPIFY_CLOUD__.clerkPublishableKey,
};
/**
 * Development only (never in a built app): a session token in localStorage
 * ("slopify.dev.cloud-token", signed with a test key the local service trusts)
 * stands in for Clerk, so accounts can be tested without a Clerk app.
 */
export const devToken = import.meta.env.DEV ? localStorage.getItem("slopify.dev.cloud-token") : null;
export const cloudEnabled = Boolean(cloudConfig.url && (devToken || /^pk_(test|live)_/.test(cloudConfig.clerkPublishableKey)));

export interface CloudProfile {
  id: string;
  displayName: string;
  avatarUrl: string | null;
  /** What friends add you with (an older online service has none). */
  friendCode?: string | null;
  /** Unique and changeable, shown as @name; friends can add you by it. */
  username?: string | null;
  /** Whether friends see what you're playing. */
  shareActivity?: boolean;
}
export interface CloudAccount {
  status: "disabled" | "loading" | "signedOut" | "signedIn";
  userId: string | null;
  email: string | null;
  profile: CloudProfile | null;
  error: string | null;
}

let account: CloudAccount = { status: cloudEnabled ? "loading" : "disabled", userId: null, email: null, profile: null, error: null };
const listeners = new Set<() => void>();
function set(patch: Partial<CloudAccount>) {
  account = { ...account, ...patch };
  listeners.forEach((l) => l());
}
export const getAccount = () => account;
export const subscribeAccount = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};
export const useAccount = () => useSyncExternalStore(subscribeAccount, () => account);

/**
 * If sign-in hasn't loaded after this long (offline, or Clerk unreachable), the
 * app says you're not signed in rather than waiting forever. Clerk still reports
 * a sign-in if it loads later.
 */
const SIGN_IN_WAIT = 15_000;
const UNREACHABLE = "Couldn't reach Slopify's sign-in. Check your connection.";
if (cloudEnabled) {
  window.setTimeout(() => {
    if (account.status === "loading" && !account.userId) set({ status: "signedOut", error: UNREACHABLE });
  }, SIGN_IN_WAIT);
}

/* ───────────────────────── Clerk, through CloudAccount.tsx ───────────────────────── */

interface ClerkBridge {
  getToken(): Promise<string | null>;
  openSignIn(): void;
  openUserProfile(): void;
  signOut(): Promise<void>;
  /** Deletes the Clerk user (the sign-in itself), which also signs out. */
  deleteUser(): Promise<void>;
}
let clerk: ClerkBridge | null = null;

/**
 * Clerk, or its sign-in window, couldn't load (offline, Clerk unreachable, or it
 * refused this address). It can't be loaded again in place, so signing in
 * offers to reload Slopify instead. Until Clerk has reported in, the same.
 */
let clerkReady = false;
let clerkFailed = false;
export function clerkUnavailable() {
  clerkFailed = true;
  // Signed in, Clerk itself works: only its windows are missing.
  if (account.userId) return;
  set({ status: "signedOut", error: UNREACHABLE });
}
export function signIn() {
  if (clerkReady && !clerkFailed) return void clerk?.openSignIn();
  if (!window.confirm("Slopify's sign-in couldn't load, probably because the connection dropped. Reload Slopify to try again?")) return;
  flushPersist();
  location.reload();
}
export const manageAccount = () => clerk?.openUserProfile();
export async function signOut() {
  await clerk?.signOut();
}
/** Deletes the sign-in (after the service's data is gone: see deleteAccount in sync.ts). */
export async function deleteSignIn() {
  await clerk?.deleteUser();
}

/** Whether `username` is free: { username (as it would be saved), available, reason }. */
export const checkUsername = (username: string, signal?: AbortSignal) =>
  cloudCall<{ username: string; available: boolean; reason: string | null }>(`/v1/usernames/${encodeURIComponent(username.trim().replace(/^@/, "") || "-")}`, { signal });

/** A fresh session token for the online service (Clerk refreshes them as needed), or null when signed out. */
export async function sessionToken() {
  if (account.status !== "signedIn" || !clerk) return null;
  return clerk.getToken();
}

/** Connected by CloudAccount.tsx once Clerk has loaded. */
export function connectClerk(bridge: ClerkBridge) {
  clerk = bridge;
}

/**
 * Clerk's sign-in state changed. On sign-in, the account's Slopify profile is
 * loaded (or created from the Clerk user's name and picture the first time),
 * and its name and picture become this app's. If that fails (a dropped
 * connection at sign-in), it tries again on its own until it works.
 */
export async function clerkChanged(user: { id: string; name: string | null; username?: string | null; email: string | null; imageUrl: string | null } | null) {
  clerkReady = true;
  window.clearTimeout(profileRetry);
  if (!user) {
    const was = account.status;
    profileLoading = null;
    set({ status: "signedOut", userId: null, email: null, profile: null, error: null });
    if (was === "signedIn") toast("Signed out", { detail: `Your library stays on ${thisDevice}.` });
    return;
  }
  if (account.userId === user.id && ((account.status === "signedIn" && account.profile) || profileLoading === user.id)) return;
  if (account.userId !== user.id) {
    profileAttempts = 0;
    set({ status: "loading", userId: user.id, email: user.email, profile: null, error: null });
  }
  profileLoading = user.id;
  try {
    let profile = await cloudCall<CloudProfile | null>("/v1/me", { as: user.id });
    if (!profile) {
      const name = (user.name || user.email?.split("@")[0] || getState().settings.profileName || "Listener").slice(0, 40);
      // The first username comes from the sign-in's own, or the email address; it can be changed in Settings.
      profile = await cloudCall<CloudProfile>("/v1/me", { method: "PUT", body: { displayName: name, avatarUrl: user.imageUrl, suggestedUsername: user.username || user.email?.split("@")[0] || null }, as: user.id });
    }
    // Another account signed in meanwhile: this one's profile isn't wanted any more.
    if (account.userId !== user.id) return;
    profileAttempts = 0;
    set({ status: "signedIn", profile, error: null });
    adoptProfile(profile);
    signedInListeners.forEach((l) => l());
  } catch (error) {
    if (account.userId !== user.id) return;
    set({ status: "signedIn", profile: null, error: message(error) });
    const delay = Math.min(60_000, 5_000 * 2 ** profileAttempts++);
    profileRetry = window.setTimeout(() => {
      if (account.userId === user.id && !account.profile) void clerkChanged(user);
    }, delay);
  } finally {
    if (profileLoading === user.id) profileLoading = null;
  }
}
/** The account whose profile is loading, the next try after a failed one, and how many have failed in a row. */
let profileLoading: string | null = null;
let profileRetry: number | undefined;
let profileAttempts = 0;

/** Things to start once signed in (library sync). */
const signedInListeners = new Set<() => void>();
export function onSignedIn(listener: () => void) {
  signedInListeners.add(listener);
}

function adoptProfile(profile: CloudProfile) {
  if (getState().settings.profileName !== profile.displayName) setState((s) => ({ settings: { ...s.settings, profileName: profile.displayName } }));
}

/** Saves the profile's display name or picture. */
export async function saveProfile(patch: Partial<Pick<CloudProfile, "displayName" | "avatarUrl" | "shareActivity" | "username">>) {
  const profile = await cloudCall<CloudProfile>("/v1/me", { method: "PUT", body: patch });
  set({ profile });
  adoptProfile(profile);
  return profile;
}

/* ───────────────────────── calling the service ───────────────────────── */

export class CloudError extends Error {
  constructor(public status: number, message: string, public body?: unknown) {
    super(message);
  }
}

const message = (error: unknown) => (error instanceof Error ? error.message : "Couldn't reach Slopify's online service.");

/**
 * Which version of the online service's calls this app makes (cloud/src/index.ts
 * MIN_CLIENT). Raise it with a change the service must be able to tell apart.
 */
export const CLOUD_CLIENT = 2;
/**
 * Set once the service said this build is too old: no more calls this session
 * (each would only be turned away again), and the desktop app looks for its update.
 */
let outdated: CloudError | null = null;

/**
 * One call to the online service as the signed-in account. Throws CloudError (with `status`, and the body for 409s).
 * With `as`, the call is only made as that account: if another one has signed in meanwhile, it throws instead.
 */
export async function cloudCall<T>(path: string, { method = "GET", body, signal, as }: { method?: string; body?: unknown; signal?: AbortSignal; as?: string } = {}): Promise<T> {
  if (outdated) throw outdated;
  const token = await clerk?.getToken();
  if (!token) throw new CloudError(401, "Sign in first.");
  if (as !== undefined && (tokenUser(token) !== as || account.userId !== as)) throw new CloudError(0, "You signed in to another account.");
  let res: Response;
  try {
    res = await send(path, {
      method,
      headers: { Authorization: `Bearer ${token}`, "X-Slopify-Client": String(CLOUD_CLIENT), ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: signal ?? AbortSignal.timeout(20_000),
      cache: "no-store",
    });
  } catch (error) {
    if ((error as Error)?.name === "AbortError") throw error;
    throw new CloudError(0, "Couldn't reach Slopify's online service. Check your connection.");
  }
  const json = (await res.json().catch(() => null)) as { ok?: boolean; result?: T; error?: { code?: string; message?: string } } | null;
  // The music server passing the call on couldn't reach the service: the same as not reaching it.
  if (res.status === 502 && json?.error?.code === "CLOUD_UNREACHABLE") throw new CloudError(0, json.error.message || "Couldn't reach Slopify's online service.");
  if (res.status === 426 && json?.error?.code === "UPDATE_REQUIRED") {
    outdated = new CloudError(426, json.error.message || "This version of Slopify is too old for your account. Update Slopify to keep syncing.", json);
    checkForUpdates();
    throw outdated;
  }
  if (!res.ok || !json?.ok) throw new CloudError(res.status, json?.error?.message || `Slopify's online service answered HTTP ${res.status}.`, json);
  return json.result as T;
}

/**
 * Whether calls go through this app's music server (/api/cloud, server/api.mjs
 * proxyCloud). That's the page's own origin, so the browser makes no CORS check
 * (an extra OPTIONS call, which the service's plan counts as a request) before
 * each one. Off for good once the server says it doesn't pass calls on.
 */
let viaServer = true;

async function send(path: string, init: RequestInit & { headers: Record<string, string> }): Promise<Response> {
  if (viaServer) {
    try {
      const res = await fetch(`/api/cloud${path}`, { ...init, headers: { ...init.headers, "X-Slopify-Cloud": cloudConfig.url } });
      if (res.status !== 404) return res;
      // CLOUD_PROXY_OFF: built for another service. NOT_FOUND: a music server from before /api/cloud.
      const code = ((await res.clone().json().catch(() => null)) as { error?: { code?: string } } | null)?.error?.code;
      if (code !== "CLOUD_PROXY_OFF" && code !== "NOT_FOUND") return res;
      viaServer = false;
    } catch (error) {
      const name = (error as Error)?.name;
      if (name === "AbortError" || name === "TimeoutError") throw error;
      // The music server didn't answer: this call goes to the service directly.
    }
  }
  return fetch(cloudConfig.url + path, init);
}

/** Who a session token is for (its `sub`), without checking it: the service does that. */
function tokenUser(token: string) {
  try {
    return (JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))) as { sub?: string }).sub ?? null;
  } catch {
    return null;
  }
}

/** The WebSocket address for a Listen Along room, carrying a fresh token (browsers can't send headers on WebSockets). */
export async function roomSocketUrl(code: string) {
  if (outdated) throw outdated;
  const token = await clerk?.getToken();
  if (!token) throw new CloudError(401, "Sign in to use Listen Along.");
  const url = new URL(`${cloudConfig.url}/v1/rooms/${encodeURIComponent(code)}/socket`);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("token", token);
  url.searchParams.set("client", String(CLOUD_CLIENT));
  return url.toString();
}
