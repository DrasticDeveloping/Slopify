/* Route changes announce their heading for keyboard and assistive activation. A touch gesture keeps its focus. */
let touch = false;
if (typeof document !== "undefined") {
  document.addEventListener("pointerdown", (event) => { touch = event.pointerType === "touch"; }, true);
  document.addEventListener("keydown", () => { touch = false; }, true);
  // VoiceOver activates controls with a synthetic click, without a pointer sequence.
  document.addEventListener("click", (event) => { if (event.detail === 0) touch = false; }, true);
}
const origins = new Map<string, WeakRef<HTMLElement>>();
let pending: { origin?: WeakRef<HTMLElement> } | null = null;

export function prepareNavigationFocus(from: unknown, to: unknown, back = false) {
  const active = document.activeElement;
  if (active instanceof HTMLElement && active !== document.body) {
    const key = JSON.stringify(from);
    origins.delete(key);
    origins.set(key, new WeakRef(active));
    if (origins.size > 50) origins.delete(origins.keys().next().value!);
  }
  pending = touch ? null : { origin: back ? origins.get(JSON.stringify(to)) : undefined };
}

export function applyNavigationFocus(root: HTMLElement) {
  if (!pending) return;
  const apply = () => {
    // A player can navigate while its closing animation still owns focus, and a menu's Go to… lands while the page
    // behind it is still inert: wait until the destination can take focus.
    if (document.querySelector('[role="dialog"][aria-modal="true"]') || root.closest("[inert]")) return false;
    const request = pending;
    pending = null;
    if (!request || touch || !root.isConnected) return true;
    const origin = request.origin?.deref();
    if (origin?.isConnected && root.contains(origin) && !origin.closest("[inert]")) {
      origin.focus({ preventScroll: true });
      return true;
    }
    const heading = root.querySelector<HTMLElement>("h1, h2, [role=heading]");
    if (heading) {
      heading.tabIndex = -1;
      heading.focus({ preventScroll: true });
    }
    return true;
  };
  if (apply()) return;
  const closed = new MutationObserver(() => { if (apply()) closed.disconnect(); });
  // Overlays leaving and the background's inert attribute being lifted both end the wait.
  closed.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["inert"] });
  return () => closed.disconnect();
}
