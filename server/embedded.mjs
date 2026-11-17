import fs from "node:fs";
import { timingSafeEqual } from "node:crypto";

export const embedded = process.env.SLOPIFY_EMBEDDED === "1";
export const embeddedSecret = embedded ? process.env.SLOPIFY_EMBEDDED_SECRET : undefined;

/** A native app can forge Origin and Fetch Metadata; only our web view has this launch's cookie. */
export function authenticated(req, secret) {
  if (!secret) return true;
  const cookies = String(req.headers.cookie || "").split(";");
  const value = cookies.map((part) => part.trim()).find((part) => part.startsWith("slopify_session="))?.slice("slopify_session=".length) || "";
  const expected = Buffer.from(secret);
  const received = Buffer.from(value);
  return expected.length === received.length && timingSafeEqual(expected, received);
}

/** Native reads this file while the boot page is waiting, even when the HTTP port is unavailable. */
export function reportStartup(state, message = "") {
  const file = process.env.SLOPIFY_EMBEDDED_STATUS;
  if (!embedded || !file) return;
  try {
    fs.writeFileSync(`${file}.tmp`, JSON.stringify({ state, message }));
    fs.renameSync(`${file}.tmp`, file);
  } catch (error) {
    console.error("[slopify] Couldn't report server startup:", error.message);
  }
}
