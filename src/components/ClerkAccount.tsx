import { ClerkProvider, useAuth, useClerk, useUser } from "@clerk/react";
import { useEffect } from "react";
import { clerkChanged, cloudConfig, connectClerk } from "../state/cloud";

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
    });
  }, [clerk, getToken]);

  useEffect(() => {
    if (!isLoaded) return;
    void clerkChanged(isSignedIn && user ? {
      id: user.id,
      name: user.fullName || user.username || null,
      email: user.primaryEmailAddress?.emailAddress ?? null,
      imageUrl: user.hasImage ? user.imageUrl : null,
    } : null);
  }, [isLoaded, isSignedIn, user?.id]);

  return null;
}

/** Clerk, loaded only in builds with accounts set up. Its sign-in and account windows open over the app. */
export default function ClerkAccount() {
  return (
    <ClerkProvider publishableKey={cloudConfig.clerkPublishableKey} appearance={{ variables: { colorPrimary: "#a78bfa" } }}>
      <ClerkBridge />
    </ClerkProvider>
  );
}
