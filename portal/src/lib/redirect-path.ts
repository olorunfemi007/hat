/** Accept only paths on this app, including their query strings. */
export function safeRedirectPath(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    /[\\\x00-\x20\x7f]/.test(value)
  ) {
    return "/dashboard";
  }
  const base = "https://portal.invalid";
  const url = new URL(value, base);
  // Dot-segment normalization can turn /a/..//host into //host.
  if (url.origin !== base || url.pathname.startsWith("//")) {
    return "/dashboard";
  }
  return url.pathname + url.search + url.hash;
}
