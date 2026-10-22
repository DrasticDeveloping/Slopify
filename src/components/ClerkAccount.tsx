import { ClerkProvider, useAuth, useClerk, useUser } from "@clerk/electron/react";
import { useEffect } from "react";
import { clerkChanged, clerkUnavailable, cloudConfig, connectClerk } from "../state/cloud";

/*
 * Slopify runs at http://127.0.0.1 or localhost, not on the Clerk app's own domain, so
 * Clerk's sign-in cookie (SameSite=Lax, on clerk.<domain>) never comes back with its
 * requests: with a production key, sign-up stalls before the email code is sent.
 * @clerk/electron's provider uses Clerk's Native API instead (enabled in the Clerk
 * dashboard under Native applications): the session travels in an Authorization
 * header, kept by the token cache below. That provider reads the cache from the
 * bridge its preload script would install; Slopify supplies one backed by this
 * window's local storage, which works in the desktop app and a browser alike.
 */
declare global {
  interface Window {
    __clerk_internal_electron?: {
      tokenCache: {
        getToken(key: string): Promise<string | null>;
        saveToken(key: string, value: string): Promise<void>;
        clearToken(key: string): Promise<void>;
      };
    };
  }
}

const tokenKey = (key: string) => `slopify.clerk.${key}`;
window.__clerk_internal_electron ??= {
  tokenCache: {
    getToken: async (key) => localStorage.getItem(tokenKey(key)),
    saveToken: async (key, value) => localStorage.setItem(tokenKey(key), value),
    clearToken: async (key) => localStorage.removeItem(tokenKey(key)),
  },
};

/** Connects Clerk's sign-in to src/state/cloud.ts. Renders nothing. */
function ClerkBridge() {
  const { isLoaded, isSignedIn, getToken } = useAuth();
  const { user } = useUser();
  const clerk = useClerk();

  useEffect(() => {
    connectClerk({
      getToken: () => getToken(),
      openSignIn: () => clerk.openSignIn(),
      openUserProfile: () => clerk.openUserProfile(),
      signOut: () => clerk.signOut(),
      deleteUser: async () => {
        await clerk.user?.delete();
      },
    });
  }, [clerk, getToken]);

  useEffect(() => {
    if (!isLoaded) return;
    void clerkChanged(isSignedIn && user ? {
      id: user.id,
      name: user.fullName || user.username || null,
      username: user.username ?? null,
      email: user.primaryEmailAddress?.emailAddress ?? null,
      imageUrl: user.hasImage ? user.imageUrl : null,
    } : null);
  }, [isLoaded, isSignedIn, user?.id]);

  return null;
}

/** Whether a failed promise is Clerk failing to load (offline, or Clerk unreachable). */
const clerkLoadFailure = (reason: unknown) => {
  const { code, message } = (reason ?? {}) as { code?: unknown; message?: unknown };
  return (typeof code === "string" && code.startsWith("failed_to_load_clerk")) || (typeof message === "string" && /^Clerk: Failed to load Clerk/.test(message));
};
// Listening from the start, before Clerk begins loading.
window.addEventListener("unhandledrejection", (event) => {
  if (!clerkLoadFailure(event.reason)) return;
  event.preventDefault();
  clerkUnavailable();
});

/**
 * Clerk, loaded only in builds with accounts set up. Its sign-in and account windows open over the app.
 * If Clerk can't load (offline), the app carries on without accounts, and signing in offers a reload
 * (src/state/cloud.ts): Clerk keeps its failed load, so it can't simply be loaded again.
 */
export default function ClerkAccount() {
  return (
    <ClerkProvider publishableKey={cloudConfig.clerkPublishableKey} appearance={{ variables: { colorPrimary: "#a78bfa" } }}>
      <ClerkBridge />
    </ClerkProvider>
  );
}
