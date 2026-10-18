import type { KeyboardEvent } from "react";

/**
 * Arrow keys for a radio group or tab list: one Tab stop for the whole group
 * (give the chosen option tabIndex 0, the rest -1), and arrows, Home and End
 * choose a neighbour and move focus to it.
 */
export function rovingKey<T>(e: KeyboardEvent<HTMLElement>, options: readonly T[], current: T, choose: (value: T) => void) {
  const at = options.indexOf(current);
  let to: number;
  if (e.key === "ArrowRight" || e.key === "ArrowDown") to = (at + 1) % options.length;
  else if (e.key === "ArrowLeft" || e.key === "ArrowUp") to = (at - 1 + options.length) % options.length;
  else if (e.key === "Home") to = 0;
  else if (e.key === "End") to = options.length - 1;
  else return;
  e.preventDefault();
  choose(options[to]);
  // Options are siblings in the same order as `options`.
  const items = e.currentTarget.parentElement?.querySelectorAll<HTMLElement>(`[role="${e.currentTarget.getAttribute("role")}"]`);
  items?.[to]?.focus();
}
