/** Whether focus is somewhere visible: hiding or removing the focused control drops it onto the page itself. */
export function focusIsVisible() {
  const el = document.activeElement as HTMLElement | null;
  return Boolean(el && el !== document.body && el.getClientRects().length);
}

/** Focuses the first of `selector`'s matches (in `root`) that's on screen. Returns whether one was. */
export function focusFirstVisible(selector: string, root: ParentNode = document) {
  const el = [...root.querySelectorAll<HTMLElement>(selector)].find((x) => x.getClientRects().length);
  el?.focus();
  return Boolean(el);
}
