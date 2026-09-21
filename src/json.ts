/* eslint-disable complexity -- Recursive JSON conversion has explicit type branches. */
export type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject;

export interface JsonObject {
  [key: string]: JsonValue;
}

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return Array.from(value).every(isJsonValue);
  return isJsonObject(value);
}

export function isJsonObject(value: unknown): value is JsonObject {
  return isPlainRecord(value) && Object.values(value).every(isJsonValue);
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function readNonBlankString(value: unknown): string | undefined {
  const text = readString(value)?.trim();
  if (!text) return undefined;
  return text;
}

export function readFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function toJsonValue(value: unknown): JsonValue | undefined {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (Array.isArray(value)) {
    return value.map(toJsonValue).filter((item): item is JsonValue => item !== undefined);
  }
  const record = asRecord(value);
  if (!record) return undefined;
  const entries: [string, JsonValue][] = [];
  for (const [key, child] of Object.entries(record)) {
    const converted = toJsonValue(child);
    if (converted !== undefined) entries.push([key, converted]);
  }
  return Object.fromEntries(entries);
}

export function toJsonObject(value: unknown): JsonObject | undefined {
  const converted = toJsonValue(value);
  return converted !== null && typeof converted === "object" && !Array.isArray(converted)
    ? converted
    : undefined;
}
