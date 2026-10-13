/*
 * Who is calling: a Clerk session token (a short-lived RS256 JWT the app gets
 * from Clerk), checked against the Clerk instance's public keys. No Clerk secret
 * is needed here: the keys are published at the instance's Frontend API, which
 * the Publishable Key names. CLERK_JWT_KEY (a PEM public key) checks tokens
 * without a network fetch, for tests or Clerk's networkless setup.
 */

export interface AuthEnv {
  CLERK_PUBLISHABLE_KEY?: string;
  CLERK_JWT_KEY?: string;
}

export interface Caller { userId: string }

const SKEW_SECONDS = 10;
const KEYS_TTL_MS = 60 * 60_000;

export class AuthError extends Error {
  status = 401;
}

const base64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=")), (c) => c.charCodeAt(0));
const json = (s: string) => JSON.parse(new TextDecoder().decode(base64url(s))) as Record<string, unknown>;

/** The Clerk Frontend API host a Publishable Key belongs to ("pk_test_" + base64("host$")). */
export function frontendApi(publishableKey: string | undefined) {
  const match = /^pk_(?:test|live)_(.+)$/.exec(publishableKey?.trim() ?? "");
  if (!match) return null;
  try {
    const host = atob(match[1]).replace(/\$$/, "");
    return /^[a-z0-9.-]+$/i.test(host) ? host : null;
  } catch {
    return null;
  }
}

let cachedKeys: { host: string; at: number; keys: Map<string, CryptoKey> } | null = null;
/** One key fetch at a time; and a key id that isn't there isn't asked about again for a minute. */
let fetching: Promise<void> | null = null;
let lastFetch = 0;
const REFETCH_MS = 60_000;
let pemKey: { pem: string; key: CryptoKey } | null = null;

async function keyFor(kid: string | undefined, env: AuthEnv): Promise<CryptoKey> {
  const algorithm = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" };
  if (env.CLERK_JWT_KEY) {
    if (pemKey?.pem !== env.CLERK_JWT_KEY) {
      const body = env.CLERK_JWT_KEY.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
      pemKey = { pem: env.CLERK_JWT_KEY, key: await crypto.subtle.importKey("spki", base64url(body), algorithm, false, ["verify"]) };
    }
    return pemKey.key;
  }
  const host = frontendApi(env.CLERK_PUBLISHABLE_KEY);
  if (!host) throw new AuthError("Sign-in isn't set up on this server (CLERK_PUBLISHABLE_KEY).");
  const fresh = cachedKeys && cachedKeys.host === host && Date.now() - cachedKeys.at < KEYS_TTL_MS;
  // An unknown key id may be a newly rotated key: fetch the set again, at most once a minute.
  const unknownKid = Boolean(fresh && kid && !cachedKeys!.keys.has(kid) && Date.now() - lastFetch > REFETCH_MS);
  if (!fresh || unknownKid) {
    fetching ??= (async () => {
      lastFetch = Date.now();
      const res = await fetch(`https://${host}/.well-known/jwks.json`, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) throw new Error(`Clerk's signing keys couldn't be loaded (HTTP ${res.status}).`);
      const { keys = [] } = (await res.json()) as { keys?: Array<JsonWebKey & { kid?: string }> };
      const map = new Map<string, CryptoKey>();
      for (const jwk of keys) if (jwk.kid && jwk.kty === "RSA") map.set(jwk.kid, await crypto.subtle.importKey("jwk", jwk, algorithm, false, ["verify"]));
      cachedKeys = { host, at: Date.now(), keys: map };
    })().finally(() => {
      fetching = null;
    });
    await fetching;
  }
  const key = kid ? cachedKeys!.keys.get(kid) : cachedKeys!.keys.values().next().value;
  if (!key) throw new AuthError("Unknown signing key.");
  return key;
}

/** The signed-in user behind a session token, or an AuthError. */
export async function verifySession(token: string | null | undefined, env: AuthEnv): Promise<Caller> {
  const parts = token?.split(".") ?? [];
  if (parts.length !== 3) throw new AuthError("Sign in to use this.");
  let header: Record<string, unknown>;
  let claims: Record<string, unknown>;
  let signature: Uint8Array;
  try {
    header = json(parts[0]);
    claims = json(parts[1]);
    signature = base64url(parts[2]);
  } catch {
    throw new AuthError("Invalid session token.");
  }
  if (!header || typeof header !== "object" || !claims || typeof claims !== "object") throw new AuthError("Invalid session token.");
  if (header.alg !== "RS256") throw new AuthError("Unsupported session token.");
  const key = await keyFor(typeof header.kid === "string" ? header.kid : undefined, env);
  const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, signature, new TextEncoder().encode(`${parts[0]}.${parts[1]}`)).catch(() => false);
  if (!valid) throw new AuthError("Invalid session token.");
  const now = Date.now() / 1000;
  if (typeof claims.exp !== "number" || claims.exp < now - SKEW_SECONDS) throw new AuthError("Your session has expired. Sign in again.");
  if (typeof claims.nbf === "number" && claims.nbf > now + SKEW_SECONDS) throw new AuthError("Session token isn't valid yet.");
  const host = frontendApi(env.CLERK_PUBLISHABLE_KEY);
  if (host && claims.iss !== `https://${host}`) throw new AuthError("Session token is from another Clerk app.");
  if (typeof claims.sub !== "string" || !claims.sub || claims.sub.length > 200) throw new AuthError("Invalid session token.");
  return { userId: claims.sub };
}
