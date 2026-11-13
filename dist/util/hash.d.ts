/** 64-bit FNV-1a-style digest, returned as 16 hex characters. */
export declare function digest(input: string): string;
/** Deterministic JSON with sorted keys, so equivalent options hash identically. */
export declare function stableStringify(value: any, seen?: Set<any>): string;
