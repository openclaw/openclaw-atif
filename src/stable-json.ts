function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries<unknown>(
      Object.keys(value)
        .sort()
        .map((key) => [key, normalize((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}

export function stableStringify(value: unknown): string {
  return `${JSON.stringify(normalize(value), null, 2)}\n`;
}

export function stableCompactStringify(value: unknown): string {
  return JSON.stringify(normalize(value));
}
