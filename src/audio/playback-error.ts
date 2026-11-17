/** Check transport separately: a media element reports HTTP failures as unsupported sources too. */
export async function explainPlaybackFailure(source?: string, mediaError?: MediaError | null): Promise<string> {
  if (!source) return "No audio file is available for this song.";
  const url = new URL(source, location.href);
  if (url.protocol === "blob:") {
    const code = mediaError?.code ?? "unknown";
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
      const blob = await response.blob();
      return `Saved file: ${blob.size} bytes, ${blob.type || "unknown format"}. Media error ${code}${mediaError?.message ? `: ${mediaError.message.slice(0, 180)}` : "."}`;
    } catch {
      return `The saved file URL is unreadable (media error ${code}). Your saved copy has not been deleted.`;
    }
  }
  if (url.origin !== location.origin || !url.pathname.startsWith("/api/")) {
    return "The media could not be loaded or decoded. Try another copy of this file.";
  }
  try {
    const response = await fetch(url, { headers: { Range: "bytes=0-1" }, cache: "no-store", signal: AbortSignal.timeout(15000) });
    if (!response.ok) {
      const body = response.headers.get("Content-Type")?.includes("application/json")
        ? await response.json().catch(() => null) : null;
      const reason = typeof body?.error?.message === "string" ? body.error.message.slice(0, 300) : "The music server couldn't provide the file.";
      await response.body?.cancel().catch(() => undefined);
      return `File request failed (${response.status}): ${reason}`;
    }
    await response.body?.cancel();
    return "The file request succeeded, but playback failed. The file may be incomplete or incompatible with iOS. Try downloading it again.";
  } catch (error) {
    return error instanceof DOMException && error.name === "TimeoutError"
      ? "The music server didn't return the file within 15 seconds. Check your connection and try again."
      : "The file request couldn't reach the music server. Check your connection and try again.";
  }
}
