/*
 * Server behaviours a caller's build was made for. One service answers every
 * installed copy, Stable and Nightly alike, so a change deployed to it reaches them
 * all. New behaviour that installed copies mustn't get yet is checked by name: a build
 * lists the names it was made with (src/state/cloud.ts CLOUD_FEATURES), and the
 * same pull request adds the name and its check here. A build has a name exactly
 * when it contains that pull request, whatever order merges and releases happen in.
 *
 * The list is the caller's own word: it only picks between behaviours the service
 * supports anyway, never who may do what or the limits that protect the service.
 */

/** A longer list is ignored entirely, rather than read in part. */
const MAX_LENGTH = 1024;

/** Whether the caller's build was made with server behaviour `name`: `X-Slopify-Features: a,b`, or `?features=a,b` on WebSockets. */
export function callerHas(request: Request, name: string): boolean {
  const raw = request.headers.get("X-Slopify-Features") ?? new URL(request.url).searchParams.get("features") ?? "";
  return name !== "" && raw.length <= MAX_LENGTH && raw.split(",").some((entry) => entry.trim() === name);
}
