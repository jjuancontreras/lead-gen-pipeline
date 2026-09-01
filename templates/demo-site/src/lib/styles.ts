// Shared primary-button style so it only needs to change in one place
// instead of being retyped at every call site.

export function btnPrimary(padding: string = "px-6 py-3"): string {
  return `rounded-full bg-brand ${padding} text-sm font-semibold uppercase tracking-wider text-text transition-transform hover:scale-105`;
}
