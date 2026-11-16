import { useState } from "react";

/**
 * An email address, blurred until it's clicked, so it isn't on show when sharing the screen.
 * A span rather than a button so menus (which focus their first button) don't land on it.
 */
export function HiddenEmail({ email }: { email: string }) {
  const [shown, setShown] = useState(false);
  const toggle = () => setShown((s) => !s);
  return (
    <span
      role="button"
      tabIndex={0}
      className={`hidden-email${shown ? " shown" : ""}`}
      title={shown ? "Hide email" : "Show email"}
      onClick={(e) => {
        e.stopPropagation();
        toggle();
      }}
      onKeyDown={(e) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        e.preventDefault();
        e.stopPropagation();
        toggle();
      }}
    >
      {email}
    </span>
  );
}
