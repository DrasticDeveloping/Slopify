import { useSyncExternalStore } from "react";
import { thisDevice } from "../lib/native";
import { toast } from "./actions";
import { getState, setState } from "./store";

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
if (cloudEnabled) {
  window.setTimeout(() => {
    if (account.status === "loading" && !account.userId) set({ status: "signedOut", error: "Couldn't reach Slopify's sign-in. Check your connection." });
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

export const signIn = () => clerk?.openSignIn();
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
 * and its name and picture become this app's.
 */
export async function clerkChanged(user: { id: string; name: string | null; username?: string | null; email: string | null; imageUrl: string | null } | null) {
  if (!user) {
    const was = account.status;
    set({ status: "signedOut", userId: null, email: null, profile: null, error: null });
    if (was === "signedIn") toast("Signed out", { detail: `Your library stays on ${thisDevice}.` });
    return;
  }
  if (account.userId === user.id && account.status === "signedIn") return;
  set({ status: "loading", userId: user.id, email: user.email, error: null });
  try {
    let profile = await cloudCall<CloudProfile | null>("/v1/me");
    if (!profile) {
      const name = (user.name || user.email?.split("@")[0] || getState().settings.profileName || "Listener").slice(0, 40);
      // The first username comes from the sign-in's own, or the email address; it can be changed in Settings.
      profile = await cloudCall<CloudProfile>("/v1/me", { method: "PUT", body: { displayName: name, avatarUrl: user.imageUrl, suggestedUsername: user.username || user.email?.split("@")[0] || null } });
    }
    set({ status: "signedIn", profile });
    adoptProfile(profile);
    signedInListeners.forEach((l) => l());
  } catch (error) {
    set({ status: "signedIn", profile: null, error: message(error) });
  }
}

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

/** One call to the online service as the signed-in account. Throws CloudError (with `status`, and the body for 409s). */
export async function cloudCall<T>(path: string, { method = "GET", body, signal }: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  const token = await clerk?.getToken();
  if (!token) throw new CloudError(401, "Sign in first.");
  let res: Response;
  try {
    res = await fetch(cloudConfig.url + path, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: signal ?? AbortSignal.timeout(20_000),
      cache: "no-store",
    });
  } catch (error) {
    if ((error as Error)?.name === "AbortError") throw error;
    throw new CloudError(0, "Couldn't reach Slopify's online service. Check your connection.");
  }
  const json = (await res.json().catch(() => null)) as { ok?: boolean; result?: T; error?: { message?: string } } | null;
  if (!res.ok || !json?.ok) throw new CloudError(res.status, json?.error?.message || `Slopify's online service answered HTTP ${res.status}.`, json);
  return json.result as T;
}

/** The WebSocket address for a Listen Along room, carrying a fresh token (browsers can't send headers on WebSockets). */
export async function roomSocketUrl(code: string) {
  const token = await clerk?.getToken();
  if (!token) throw new CloudError(401, "Sign in to use Listen Along.");
  const url = new URL(`${cloudConfig.url}/v1/rooms/${encodeURIComponent(code)}/socket`);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("token", token);
  return url.toString();
}
