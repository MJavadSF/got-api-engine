/** Keep an existing scheme ("Bearer x", "Basic x"); prefix bare tokens with Bearer. */
export function normalizeAuthorization(value: string): string {
  const v = value.trim();
  return /^[A-Za-z][\w.~+-]*\s+\S/.test(v) ? v : `Bearer ${v}`;
}

export function isAuthRequired(mode: unknown): boolean {
  return mode === true || mode === "bearer";
}

export function isAuthOptional(mode: unknown): boolean {
  return mode === "optional";
}

export function isAuthDisabled(mode: unknown): boolean {
  return mode === false || mode === "none";
}
