export function sessionHref(id: string): string {
  return `?session=${encodeURIComponent(id)}`;
}

export function safeHttpsHref(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}
