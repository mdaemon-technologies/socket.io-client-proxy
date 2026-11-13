/** 64-bit FNV-1a-style digest, returned as 16 hex characters. */
export function digest(input: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x1b873593;
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2 ^ c, 0x85ebca6b);
  }
  return ((h1 >>> 0).toString(16).padStart(8, "0")) + ((h2 >>> 0).toString(16).padStart(8, "0"));
}

/** Deterministic JSON with sorted keys, so equivalent options hash identically. */
export function stableStringify(value: any, seen: Set<any> = new Set()): string {
  if (value === undefined) return "undefined";
  if (value === null) return "null";

  const type = typeof value;
  if (type === "function") return `fn:${String(value)}`;
  if (type !== "object") return JSON.stringify(value) ?? String(value);
  if (seen.has(value)) return "[cyclic]";

  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value.map((v) => stableStringify(v, seen)).join(",")}]`;
    }
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k], seen)}`).join(",")}}`;
  }
  finally {
    seen.delete(value);
  }
}
