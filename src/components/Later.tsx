import { startTransition, useEffect, useState, type ReactNode } from "react";
import { hasScrollRestore } from "../state/actions";

/**
 * What's below the first screen of a page, built just after the page itself: as a low-priority update React spreads
 * across frames, so opening the page (and its slide in) isn't held up building it. A page going back to where it was
 * scrolled builds it straight away, so it lands there without a jump. Children are a function, so not even their
 * elements are made until then.
 */
export function Later({ children }: { children: () => ReactNode }) {
  const [ready, setReady] = useState(hasScrollRestore);
  useEffect(() => {
    if (ready) return;
    const frame = requestAnimationFrame(() => startTransition(() => setReady(true)));
    return () => cancelAnimationFrame(frame);
  }, [ready]);
  return ready ? <>{children()}</> : null;
}
