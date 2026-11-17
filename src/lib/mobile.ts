import { useEffect, useLayoutEffect, useRef, type TouchEvent, type MouseEvent, type RefObject } from "react";
import { nativeFeedback } from "./native";

const phone = () => window.matchMedia("(max-width: 680px)").matches;

/** Dismiss the search keyboard only when the listener deliberately scrolls content. */
export function dismissKeyboard() {
  const active = document.activeElement;
  if (phone() && active instanceof HTMLElement && active.matches("input, textarea, [contenteditable=true]")) active.blur();
}

/** Split a selector list on its top-level commas (not those inside :is(), :not() and the like). */
function selectorList(text: string) {
  const out: string[] = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "(" || c === "[") depth++;
    else if (c === ")" || c === "]") depth--;
    else if (c === "," && depth === 0) { out.push(text.slice(from, i).trim()); from = i + 1; }
  }
  out.push(text.slice(from).trim());
  return out;
}

function stripHover(rules: CSSRuleList, owner: CSSStyleSheet | CSSGroupingRule) {
  for (let i = rules.length - 1; i >= 0; i--) {
    const rule = rules[i];
    if (rule instanceof CSSStyleRule && rule.selectorText.includes(":hover")) {
      const keep = selectorList(rule.selectorText).filter((x) => !x.includes(":hover"));
      if (keep.length) rule.selectorText = keep.join(", ");
      else owner.deleteRule(i);
    } else if ("cssRules" in rule && rule.cssRules) stripHover(rule.cssRules as CSSRuleList, rule as CSSGroupingRule);
  }
}

/**
 * iOS keeps :hover on whatever was last tapped, so a row or button stays lit after the finger lifts. A touch-only
 * device has no hover, so those rules are dropped from the app's stylesheets once they load.
 */
export function useNoStickyHover() {
  useEffect(() => {
    if (!window.matchMedia("(hover: none) and (pointer: coarse)").matches) return;
    const done = new WeakSet<CSSStyleSheet>();
    const run = () => {
      for (const sheet of [...document.styleSheets]) {
        if (done.has(sheet)) continue;
        try {
          stripHover(sheet.cssRules, sheet);
          done.add(sheet);
        } catch { /* Not loaded yet, or another origin's: left as it is. */ }
      }
    };
    run();
    window.addEventListener("load", run);
    // Development reloads styles in place; production has one stylesheet, so this rarely does anything.
    const observer = new MutationObserver(run);
    observer.observe(document.head, { childList: true, subtree: true, characterData: true });
    return () => { window.removeEventListener("load", run); observer.disconnect(); };
  }, []);
}

/** Light selection feedback for deliberate controls, never playback/scroll updates. */
export function useNativeFeedback() {
  useEffect(() => {
    const click = (e: globalThis.MouseEvent) => {
      if (!e.isTrusted || !(e.target instanceof Element)) return;
      const control = e.target.closest(".mobile-nav button, [role=switch], .like-btn, .menu-item, .menu-tile");
      if (control && !control.matches(":disabled, [aria-disabled=true]")) nativeFeedback();
    };
    document.addEventListener("click", click, true);
    return () => document.removeEventListener("click", click, true);
  }, []);
}

/** Nearest ancestor (up to the sheet) that scrolls along the given axis. */
function scrollerOf(node: Element | null, root: Element, axis: "x" | "y") {
  for (let el = node; el && el !== root.parentElement; el = el.parentElement) {
    if (!(el instanceof HTMLElement)) continue;
    const style = getComputedStyle(el);
    if (axis === "y" ? el.scrollHeight > el.clientHeight + 1 && /auto|scroll/.test(style.overflowY)
      : el.scrollWidth > el.clientWidth + 1 && /auto|scroll/.test(style.overflowX)) return el;
    if (el === root) break;
  }
  return null;
}

/**
 * Pull a sheet down from anywhere on it, as in iOS: a downward drag that starts where nothing is left to scroll up
 * moves the sheet with the finger; content still scrolls normally, and sliders and text fields keep their gestures.
 * Releasing past a distance, or with a downward flick, dismisses it and the sheet carries on at the finger's speed.
 */
/*
 * The drag's state lives in data-sheet ("dragging" / "flung"), not a class: closing re-renders the sheet, and React
 * rewrites its class list, which dropped a class set here and let the closing animation run on top of the fling.
 * `maxFlingMs` is how long the sheet may take to carry on off-screen: no longer than it stays mounted once closed.
 */
export function useSheetDrag(surface: RefObject<HTMLElement | null>, dismiss: () => void, enabled = true, maxFlingMs = 180) {
  const dismissRef = useRef(dismiss);
  dismissRef.current = dismiss;
  useLayoutEffect(() => {
    const el = surface.current;
    if (!el || !phone() || el.matches(".menu.sub")) return;
    // A transition can reverse from its current position when closed before it has finished opening.
    el.dataset.sheetEnter = "";
    void el.offsetHeight;
    const frame = requestAnimationFrame(() => { delete el.dataset.sheetEnter; });
    return () => { cancelAnimationFrame(frame); delete el.dataset.sheetEnter; };
  }, [surface]);
  useLayoutEffect(() => {
    const el = surface.current;
    if (!el) return;
    // Only a sheet's own overlay dims with the drag (the full player sits straight in the app, which must not change).
    const parent = el.parentElement;
    const layer = parent?.matches(".modal-layer, .menu-layer") ? parent : null;
    if (!enabled) return;
    // Reset without animating, so a sheet reopened mid-fling comes in only with its opening animation.
    el.dataset.sheet = "dragging";
    el.style.removeProperty("--sheet-drag-y");
    el.style.removeProperty("--sheet-fling-ms");
    el.style.removeProperty("--sheet-fling-ease");
    layer?.style.removeProperty("background-color");
    void el.offsetHeight;
    delete el.dataset.sheet;
    /** "scroll": the content is scrolling under the finger; the sheet takes over once it reaches its top (`handoff`). */
    // A native scroll can come to rest a fraction of a pixel from the top.
    const atTop = (scroller: HTMLElement | null) => !scroller || scroller.scrollTop < 1;
    type Gesture = { id: number; x: number; y: number; state: "pending" | "drag" | "scroll" | "off"; origin: number; base: number; offset: number; travel: number; lastY: number; handoff: boolean; scrollY: HTMLElement | null; scrollX: HTMLElement | null; samples: { y: number; t: number }[] };
    let g: Gesture | null = null;
    let suppressUntil = 0;
    let alive = true;
    let check = 0;
    const settle = () => {
      delete el.dataset.sheet;
      el.style.setProperty("--sheet-drag-y", "0px");
      layer?.style.removeProperty("background-color");
    };
    const start = (e: globalThis.TouchEvent) => {
      // Suppression belongs to the previous release, never to a fresh tap (including one on a text field).
      suppressUntil = 0;
      if (e.touches.length !== 1) {
        if (g?.state === "drag") settle();
        g = null;
        return;
      }
      if (!phone()) return;
      const target = e.target as Element;
      if (target.closest("input, textarea, select, [contenteditable=true], [role=slider], .slider, [data-no-sheet-drag]")) return;
      const t = e.touches[0];
      const base = Number.parseFloat(getComputedStyle(el).translate.split(" ")[1]) || 0;
      if (base) {
        // Freeze the spring where it is now, rather than jumping to its destination under the finger.
        el.style.setProperty("--sheet-drag-y", `${base}px`);
        el.dataset.sheet = "dragging";
      }
      g = { id: t.identifier, x: t.clientX, y: t.clientY, state: base ? "drag" : "pending", origin: t.clientY, base, offset: base, travel: 0, lastY: t.clientY, handoff: false, scrollY: scrollerOf(target, el, "y"), scrollX: scrollerOf(target, el, "x"), samples: [{ y: t.clientY, t: e.timeStamp }] };
    };
    const move = (e: globalThis.TouchEvent) => {
      if (!g || g.state === "off") return;
      const t = [...e.touches].find((x) => x.identifier === g!.id);
      if (!t || e.touches.length !== 1) return;
      const dx = t.clientX - g.x;
      const dy = t.clientY - g.y;
      const down = t.clientY > g.lastY;
      g.lastY = t.clientY;
      if (g.state === "pending") {
        if (Math.abs(dx) < 2 && Math.abs(dy) < 2) return;
        // Sideways belongs to a carousel. Pushing up, or down through content not yet at its top, scrolls it.
        const sideways = Math.abs(dx) > Math.abs(dy) * (g.scrollX ? 0.6 : 1.2);
        if (sideways) { g.state = "off"; return; }
        if (dy <= 0 || !atTop(g.scrollY) || !e.cancelable) { g.state = "scroll"; return; }
        g.state = "drag";
        g.origin = t.clientY;
        el.dataset.sheet = "dragging";
      } else if (g.state === "scroll") {
        // The content just reached its top with the finger still pulling down: the sheet follows from here, in the
        // same gesture, as in iOS. (Nothing to cancel: the content can't scroll further up and doesn't overscroll.)
        // Only while iOS is scrolling the content under this touch (its moves can't be cancelled then), so a tap's
        // finger roll on a sheet already at its top stays a tap.
        // A handle has no native scroll to wait for: its cancelable moves can reverse direction too.
        if (!down || !atTop(g.scrollY) || (e.cancelable && (g.scrollY || dy <= 8))) return;
        g.state = "drag";
        g.handoff = !e.cancelable;
        g.origin = g.handoff ? t.clientY : g.y;
        g.travel = 9;
        g.samples = [{ y: t.clientY, t: e.timeStamp }];
        el.dataset.sheet = "dragging";
      }
      const raw = g.base + t.clientY - g.origin;
      if (g.handoff) {
        // The native scroll still owns this touch: pushed back up past where it took over, the content scrolls again.
        if (raw < 0) {
          g.state = "scroll";
          g.offset = 0;
          // Straight back to rest (still "dragging", so no easing to snap out of if the finger turns down again).
          el.style.setProperty("--sheet-drag-y", "0px");
          layer?.style.removeProperty("background-color");
          return;
        }
        if (g.scrollY && g.scrollY.scrollTop !== 0) g.scrollY.scrollTop = 0;
      }
      // Above its resting place the sheet resists, the way an iOS sheet does.
      g.offset = raw >= 0 ? raw : -Math.min(28, Math.sqrt(-raw) * 2.4);
      g.travel = Math.max(g.travel, Math.abs(raw - g.base));
      // WebKit drops the tap once a move is cancelled, so a few pixels of finger roll stay a tap. Nothing scrolls
      // meanwhile: the content is at its top and pages don't overscroll.
      if (g.travel > 8 && e.cancelable) e.preventDefault();
      g.samples.push({ y: t.clientY, t: e.timeStamp });
      if (g.samples.length > 6) g.samples.shift();
      el.style.setProperty("--sheet-drag-y", `${g.offset}px`);
      const progress = Math.max(0, Math.min(1, g.offset / Math.max(1, el.offsetHeight)));
      if (layer) layer.style.backgroundColor = `rgb(0 0 0 / ${(0.5 * (1 - progress)).toFixed(3)})`;
    };
    const end = (e: globalThis.TouchEvent) => {
      const current = g;
      if (!current || ![...e.changedTouches].some((x) => x.identifier === current.id)) return;
      g = null;
      if (current.state !== "drag") {
        if (current.handoff) settle();
        return;
      }
      // A tap whose finger rolled a few pixels is still a tap; only a real drag swallows the click.
      if (current.travel > 8) suppressUntil = performance.now() + 400;
      // Speed over the last moment only: dragging, holding still, then letting go is not a flick.
      const recent = current.samples.filter((x) => e.timeStamp - x.t < 100);
      const first = recent[0] ?? current.samples[current.samples.length - 1];
      const last = current.samples[current.samples.length - 1];
      const velocity = (last.y - first.y) / Math.max(1, last.t - first.t);
      const height = el.offsetHeight || 600;
      const threshold = Math.min(150, height * 0.22);
      if (e.type === "touchend" && (current.offset > threshold || (current.offset > 40 && velocity > 0.5))) {
        // Carry on down at (at least) the finger's speed, within the time the layer takes to close.
        const remaining = Math.max(0, height - current.offset);
        const ms = Math.round(Math.max(110, Math.min(maxFlingMs, remaining / Math.max(velocity, 1.4))));
        el.dataset.sheet = "flung";
        el.style.setProperty("--sheet-fling-ms", `${ms}ms`);
        // The curve starts at the finger's own speed (as a fraction of the average it needs): let go slowly and the
        // sheet eases away; flicked, it keeps the flick's speed and slows into place.
        const lead = Math.min(3, Math.max(0, (velocity * ms) / Math.max(1, remaining)));
        el.style.setProperty("--sheet-fling-ease", `cubic-bezier(0.25, ${(0.25 * lead).toFixed(3)}, 0.25, 1)`);
        el.style.setProperty("--sheet-drag-y", `${height + 40}px`);
        if (layer) layer.style.backgroundColor = "rgb(0 0 0 / 0)";
        nativeFeedback("light");
        dismissRef.current();
        // Closing turns this effect off; if the sheet declined to close, it comes back instead of staying off-screen.
        check = window.setTimeout(() => {
          if (!alive) return;
          el.style.removeProperty("--sheet-fling-ms");
          settle();
        }, 200);
      } else settle();
    };
    // A drag that began on a button never also presses it.
    const click = (e: globalThis.MouseEvent) => {
      if (performance.now() < suppressUntil) { e.preventDefault(); e.stopPropagation(); }
    };
    el.addEventListener("touchstart", start, { passive: true });
    el.addEventListener("touchmove", move, { passive: false });
    el.addEventListener("touchend", end);
    el.addEventListener("touchcancel", end);
    el.addEventListener("click", click, true);
    return () => {
      alive = false;
      clearTimeout(check);
      el.removeEventListener("touchstart", start);
      el.removeEventListener("touchmove", move);
      el.removeEventListener("touchend", end);
      el.removeEventListener("touchcancel", end);
      el.removeEventListener("click", click, true);
      if (g && (g.state === "drag" || el.classList.contains("back-dragging"))) settle();
    };
  }, [enabled, surface]);
}

/** Drops a released long press's compatibility click, until the next deliberate interaction. */
function swallowNextClick() {
  const drop = (e: globalThis.MouseEvent) => {
    if (e.detail === 0) { stop(); return; }
    e.preventDefault();
    e.stopPropagation();
    stop();
  };
  const stop = () => {
    clearTimeout(timer);
    document.removeEventListener("click", drop, true);
    document.removeEventListener("touchstart", stop, true);
    document.removeEventListener("pointerdown", stop, true);
    document.removeEventListener("keydown", stop, true);
  };
  const timer = window.setTimeout(stop, 400);
  document.addEventListener("click", drop, true);
  document.addEventListener("touchstart", stop, true);
  document.addEventListener("pointerdown", stop, true);
  document.addEventListener("keydown", stop, true);
}

/**
 * Touch-and-hold is a menu gesture; moving to scroll cancels it. A hold that starts on one of `ignore` is left to it
 * (a row's own buttons); a card that is one big link passes a narrower list, so holding it anywhere opens its menu.
 */
export function useLongPress(open: (element: HTMLElement) => void, ignore = "button, a, input, [role=slider]") {
  const timer = useRef(0);
  const start = useRef<{ x: number; y: number } | null>(null);
  const fired = useRef(false);
  const cancel = () => { clearTimeout(timer.current); start.current = null; };
  useEffect(() => () => clearTimeout(timer.current), []);
  return {
    onTouchStart(e: TouchEvent<HTMLElement>) {
      cancel();
      fired.current = false;
      if (e.touches.length !== 1 || (e.target as Element).closest(ignore)) return;
      const element = e.currentTarget;
      start.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
      timer.current = window.setTimeout(() => {
        fired.current = true;
        nativeFeedback("light");
        open(element);
      }, 450);
    },
    onTouchMove(e: TouchEvent<HTMLElement>) {
      const first = start.current;
      if (!first || e.touches.length !== 1 || Math.hypot(e.touches[0].clientX - first.x, e.touches[0].clientY - first.y) > 10) cancel();
    },
    onTouchEnd() {
      cancel();
      // The menu opened under the finger: the tap iOS may make of the release mustn't choose one of its items.
      // That one-shot drop covers the release; the hold's guard ends here, so a later deliberate tap (or an
      // assistive activation, which has no touch of its own) isn't taken for it.
      if (fired.current) swallowNextClick();
      fired.current = false;
    },
    onTouchCancel() {
      cancel();
      fired.current = false;
    },
    onClickCapture(e: MouseEvent<HTMLElement>) {
      if (!fired.current) return;
      fired.current = false;
      e.preventDefault();
      e.stopPropagation();
    },
    onContextMenuCapture(e: MouseEvent<HTMLElement>) {
      if (fired.current) { e.preventDefault(); e.stopPropagation(); }
    },
  };
}

/** Keep sheets and forms inside the visible area above the iOS keyboard. */
export function useMobileViewport() {
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const update = () => {
      const root = document.documentElement;
      // Pinch zoom must retain its own viewport rather than reflowing the app.
      if (viewport.scale !== 1) return;
      root.style.setProperty("--visible-height", `${viewport.height}px`);
      root.style.setProperty("--visible-top", `${viewport.offsetTop}px`);
      root.classList.toggle("keyboard-open", window.innerHeight - viewport.height > 150 &&
        document.activeElement?.matches("input, textarea, [contenteditable=true]") === true);
    };
    update();
    viewport.addEventListener("resize", update);
    viewport.addEventListener("scroll", update);
    document.addEventListener("focusin", update);
    document.addEventListener("focusout", update);
    return () => {
      viewport.removeEventListener("resize", update);
      viewport.removeEventListener("scroll", update);
      document.removeEventListener("focusin", update);
      document.removeEventListener("focusout", update);
      document.documentElement.classList.remove("keyboard-open");
      document.documentElement.style.removeProperty("--visible-height");
      document.documentElement.style.removeProperty("--visible-top");
    };
  }, []);
}

/**
 * iOS's edge swipe back: a rightward drag from the left edge carries the page with the finger, uncovering the page Back
 * returns to (App keeps it built underneath, `.main-scroll.back-page`), which comes in from 30% to the left under a
 * fading shade. Releasing past a third of the width, or with a flick, finishes the slide and goes back; anything less
 * springs back. It only starts when there is a page to go back to.
 *
 * Each frame moves only those three elements, by their own inline styles: a custom property on the main area made every
 * element on both pages restyle with every move of the finger.
 */
export function useEdgeBack(area: RefObject<HTMLElement | null>, canGoBack: () => boolean, back: () => void, identity: () => unknown) {
  const latest = useRef({ canGoBack, back, identity });
  latest.current = { canGoBack, back, identity };
  useEffect(() => {
    const el = area.current;
    if (!el) return;
    type Parts = { page: HTMLElement | null; under: HTMLElement | null; shade: HTMLElement | null };
    type Gesture = { x: number; y: number; state: "pending" | "drag"; samples: { x: number; at: number }[]; dx: number; offset: number; identity: unknown };
    let g: Gesture | null = null;
    let timer = 0;
    /** What this swipe moves, found when it starts (going back changes which page is which). */
    let parts: Parts = { page: null, under: null, shade: null };
    const find = (): Parts => ({
      page: el.querySelector<HTMLElement>(":scope > .main-scroll:not(.back-page)"),
      under: el.querySelector<HTMLElement>(":scope > .main-scroll.back-page"),
      shade: el.querySelector<HTMLElement>(":scope > .back-shade"),
    });
    const width = () => el.getBoundingClientRect().width || window.innerWidth;
    const show = (dx: number) => {
      const w = width();
      const progress = Math.min(1, dx / w);
      // A page built underneath during the swipe (just after going back) is taken up as soon as it's there.
      parts.under ??= el.querySelector<HTMLElement>(":scope > .main-scroll.back-page");
      const { page, under, shade } = parts;
      if (page) page.style.translate = `${dx}px 0`;
      if (under) {
        // Shown only once it's clipped to the strip (see app.css): the page over it is see-through.
        under.dataset.revealed = "";
        const shift = -0.3 * w * (1 - progress);
        under.style.translate = `${shift}px 0`;
        // Only the strip the page has uncovered (the page is see-through, so the rest would show through it).
        under.style.clipPath = `inset(0 ${Math.max(0, w - dx + shift)}px 0 0)`;
      }
      if (shade) {
        shade.style.transform = `scaleX(${progress})`;
        shade.style.opacity = `${0.3 * (1 - progress)}`;
      }
    };
    const reset = () => {
      el.classList.remove("back-dragging", "back-settling", "back-flung");
      el.style.removeProperty("--back-ms");
      if (parts.under) delete parts.under.dataset.revealed;
      for (const part of [parts.page, parts.under, parts.shade]) {
        part?.style.removeProperty("translate");
        part?.style.removeProperty("clip-path");
        part?.style.removeProperty("transform");
        part?.style.removeProperty("opacity");
      }
      parts = { page: null, under: null, shade: null };
    };
    const start = (e: globalThis.TouchEvent) => {
      // A second finger mid-drag calls it off: the page goes back where it was.
      if (g?.state === "drag") settle();
      g = null;
      if (!phone() || e.touches.length !== 1 || el.classList.contains("back-flung")) return;
      const t = e.touches[0];
      if (t.clientX - el.getBoundingClientRect().left > 24) return;
      if ((e.target as Element).closest("input, textarea, select, [contenteditable=true], [role=slider], .slider")) return;
      if (!latest.current.canGoBack()) return;
      // A tab switch can replace the page before the old spring's reset timer runs.
      if (parts.page && parts.page !== find().page) { clearTimeout(timer); reset(); }
      let offset = 0;
      if (el.classList.contains("back-settling") && parts.page === find().page) {
        // Read the painted position before removing the spring's transition.
        offset = Number.parseFloat(getComputedStyle(parts.page!).translate) || 0;
        clearTimeout(timer);
        el.classList.remove("back-settling");
        el.classList.add("back-dragging");
        show(offset);
      }
      g = { x: t.clientX, y: t.clientY, state: "pending", samples: [{ x: t.clientX, at: e.timeStamp }], dx: offset, offset, identity: latest.current.identity() };
    };
    const move = (e: globalThis.TouchEvent) => {
      if (!g) return;
      if (g.identity !== latest.current.identity()) { g = null; clearTimeout(timer); reset(); return; }
      if (e.touches.length !== 1) { cancel(); return; }
      const t = e.touches[0];
      const dx = t.clientX - g.x;
      const dy = t.clientY - g.y;
      if (g.state === "pending") {
        if (Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx)) { cancel(); return; }
        if (dx < -4 || !e.cancelable) { cancel(); return; }
        // Keep shelves from taking a drag that is clearly heading right; a tap's finger roll or a scroll stays theirs.
        if (dx > 3 && dx > Math.abs(dy) * 1.2) e.preventDefault();
        if (dx < 10 || dx <= Math.abs(dy) * 1.2) return;
        g.state = "drag";
        clearTimeout(timer);
        // A swipe that starts while the last one is still settling takes over from where it is.
        if (!parts.page) parts = find();
        el.classList.remove("back-settling");
        el.classList.add("back-dragging");
      }
      if (e.cancelable) e.preventDefault();
      g.dx = Math.max(0, dx + g.offset);
      g.samples.push({ x: t.clientX, at: e.timeStamp });
      while (g.samples.length > 2 && e.timeStamp - g.samples[0].at > 100) g.samples.shift();
      show(g.dx);
    };
    /** With no page built underneath yet (just after a page change), the previous page slides in once it's there. */
    const enter = () => {
      const reduced = document.documentElement.dataset.motion === "reduce" || window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      const page = el.querySelector<HTMLElement>(":scope > .main-scroll:not(.back-page)");
      if (reduced || !page?.animate) return;
      page.animate([{ transform: "translateX(-28%)", opacity: 0.55 }, { transform: "none", opacity: 1 }], { duration: 380, easing: "cubic-bezier(0.32, 0.72, 0, 1)" });
    };
    const settle = () => {
      el.classList.remove("back-flung");
      el.classList.remove("back-dragging");
      el.classList.add("back-settling");
      show(0);
      clearTimeout(timer);
      timer = window.setTimeout(reset, 360);
    };
    const end = (e: globalThis.TouchEvent) => {
      const gesture = g;
      g = null;
      if (!gesture) return;
      if (gesture.state !== "drag") { if (el.classList.contains("back-dragging")) settle(); return; }
      if (gesture.identity !== latest.current.identity()) { reset(); return; }
      // Speed over the last moment only: dragging, holding still, then letting go is not a flick.
      const recent = gesture.samples.filter((x) => e.timeStamp - x.at < 100);
      const first = recent[0];
      const last = recent[recent.length - 1];
      const velocity = first && last && last.at > first.at ? (last.x - first.x) / (last.at - first.at) : 0;
      const w = width();
      if (gesture.dx > w * 0.33 || (gesture.dx > 40 && velocity > 0.35)) {
        // Carries on at the finger's speed, then the previous page is the page.
        const ms = Math.round(Math.max(140, Math.min(260, (w - gesture.dx) / Math.max(velocity, 1.2))));
        el.classList.remove("back-dragging");
        el.classList.add("back-flung");
        el.style.setProperty("--back-ms", `${ms}ms`);
        show(w);
        nativeFeedback("light");
        clearTimeout(timer);
        timer = window.setTimeout(() => {
          // Something opened over the page (or it went elsewhere) during the slide: put the page back instead.
          if (gesture.identity !== latest.current.identity() || parts.page !== find().page) { reset(); return; }
          if (!latest.current.canGoBack()) { settle(); return; }
          const shown = Boolean(parts.under);
          latest.current.back();
          reset();
          if (!shown) enter();
        }, ms);
        e.preventDefault();
      } else settle();
    };
    const cancel = () => {
      const gesture = g;
      g = null;
      if (gesture && (gesture.state === "drag" || el.classList.contains("back-dragging"))) settle();
    };
    el.addEventListener("touchstart", start, { passive: true });
    el.addEventListener("touchmove", move, { passive: false });
    el.addEventListener("touchend", end);
    el.addEventListener("touchcancel", cancel);
    return () => {
      el.removeEventListener("touchstart", start);
      el.removeEventListener("touchmove", move);
      el.removeEventListener("touchend", end);
      el.removeEventListener("touchcancel", cancel);
      clearTimeout(timer);
      reset();
    };
  }, [area]);
}
