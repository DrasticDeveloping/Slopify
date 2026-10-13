import { lazy, Suspense, useEffect, type ReactNode } from "react";
import { clerkChanged, cloudEnabled, connectClerk, devToken } from "../state/cloud";

/** Clerk (about 150 KB) loads only when this build has accounts. */
const ClerkAccount = lazy(() => import("./ClerkAccount"));

/** Development stand-in for Clerk (see devToken in state/cloud.ts). */
function DevAccount() {
  useEffect(() => {
    const token = devToken!;
    const claims = JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))) as { sub: string };
    let signedIn = true;
    const name = localStorage.getItem("slopify.dev.cloud-name") || "Test listener";
    connectClerk({
      getToken: async () => (signedIn ? token : null),
      openSignIn: () => {
        signedIn = true;
        void clerkChanged({ id: claims.sub, name, email: `${claims.sub}@test.local`, imageUrl: null });
      },
      openUserProfile: () => undefined,
      signOut: async () => {
        signedIn = false;
        await clerkChanged(null);
      },
    });
    void clerkChanged({ id: claims.sub, name, email: `${claims.sub}@test.local`, imageUrl: null });
  }, []);
  return null;
}

/** Slopify accounts, when this build has the online service set up (release.config.json). */
export function CloudAccount({ children }: { children: ReactNode }) {
  if (!cloudEnabled) return <>{children}</>;
  if (import.meta.env.DEV && devToken) return <><DevAccount />{children}</>;
  // Clerk sits beside the app rather than around it: the app talks to it through state/cloud.ts.
  return (
    <>
      <Suspense fallback={null}>
        <ClerkAccount />
      </Suspense>
      {children}
    </>
  );
}
