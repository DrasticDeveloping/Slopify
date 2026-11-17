import { createContext, useContext, useState, type SetStateAction } from "react";

/** Session-only view choices belong to a history entry, along with its scroll position. */
export interface PageEntry {
  id: number;
  state: Map<string, unknown>;
}
let sequence = 0;
export const newPageEntry = (): PageEntry => ({ id: ++sequence, state: new Map() });
export const PageStateContext = createContext<PageEntry | null>(null);

export function usePageState<T>(key: string, initial: T) {
  const entry = useContext(PageStateContext);
  const [value, update] = useState<T>(() => entry?.state.has(key) ? entry.state.get(key) as T : initial);
  const set = (next: SetStateAction<T>) => {
    // Write now: a tab switch can unmount this page before React runs an updater.
    const current = entry?.state.has(key) ? entry.state.get(key) as T : value;
    const result = typeof next === "function" ? (next as (prev: T) => T)(current) : next;
    entry?.state.set(key, result);
    update(result);
  };
  return [value, set] as const;
}
