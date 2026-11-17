/** Both the app switch and the system preference apply to JavaScript scrolling too. */
export function scrollBehavior(): ScrollBehavior {
  return document.documentElement.dataset.motion === "reduce" || window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth";
}
