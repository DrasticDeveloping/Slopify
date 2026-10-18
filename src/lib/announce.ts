/**
 * Tells screen reader users about something that changed without moving their
 * focus (a song moved, a selection grew), through one polite live region.
 */
let region: HTMLElement | null = null;

export function announce(message: string) {
  if (!region) {
    region = document.createElement("div");
    region.className = "sr-only";
    region.setAttribute("role", "status");
    region.setAttribute("aria-live", "polite");
    document.body.appendChild(region);
  }
  // Cleared first, so the same message twice in a row is read twice.
  region.textContent = "";
  const target = region;
  requestAnimationFrame(() => {
    target.textContent = message;
  });
}
