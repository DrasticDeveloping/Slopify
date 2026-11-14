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
        // Never skipped quietly: the caller signs out instead and says the sign-in is still there.
        if (!clerk.user) throw new Error("No one is signed in to delete.");
        await clerk.user.delete();
      },
      clientId: () => clerk.client?.id ?? null,
      sessionStarted: () => clerk.session?.createdAt.getTime() ?? null,
      signedIn: () => Boolean(clerk.session),
      swapSession: async (ticket) => {
        // Only one session at a time (the Clerk app's setting), so the old one ends first.
        // The callback stands in for Clerk's usual navigation after signing out, which would reload the page.
        const userId = clerk.user?.id;
        if (!userId) throw new Error("No one is signed in to renew.");
        await clerk.signOut(async () => undefined);
        // A dropped connection is tried again before giving up. The ticket works once, so after a
        // failure the client is checked first: the sign-in may have gone through with its answer lost.
        let sessionId: string | null = null;
        for (let attempt = 1; ; attempt++) {
          try {
            const client = clerk.client;
            if (!client) throw new Error("Clerk has no client to sign in with.");
            if (!sessionId && attempt > 1) {
              await client.reload();
              sessionId = client.signedInSessions.find((session) => session.user?.id === userId)?.id ?? null;
            }
            if (!sessionId) {
              const signIn = await client.signIn.create({ strategy: "ticket", ticket });
              if (signIn.status !== "complete" || !signIn.createdSessionId) throw new Error(`Signing in again stopped at ${signIn.status}.`);
              sessionId = signIn.createdSessionId;
            }
            await clerk.setActive({ session: sessionId });
            return;
          } catch (error) {
            if (attempt >= 3 || clerk.session) throw error;
            await new Promise((resolve) => window.setTimeout(resolve, attempt * 5_000));
          }
        }
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
