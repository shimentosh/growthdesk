/** Shared by every text-like control so they line up: 32px, 13px, strong hairline, accent on focus. */
export const controlClass =
  "w-full rounded-sm border border-line-strong bg-field text-sm text-text transition-colors " +
  "placeholder:text-text-3 focus:border-accent disabled:cursor-not-allowed disabled:opacity-60 " +
  "read-only:bg-well aria-invalid:border-bad";

/*
 * `cn` does not merge conflicting utilities, so a caller's `w-48` next to the
 * built-in `w-full` would lose on stylesheet order. When the caller sizes the
 * control (an unprefixed w-*), the default width is dropped.
 */
const sizedByCaller = (className?: string) => /(^|\s)w-/.test(className ?? "");
export const fullUnlessSized = (className?: string) => (sizedByCaller(className) ? "" : "w-full");

/** controlClass with its `w-full` dropped when the caller sizes the control. */
export const sizedControlClass = (className?: string) => controlClass.replace("w-full ", fullUnlessSized(className) && "w-full ");
