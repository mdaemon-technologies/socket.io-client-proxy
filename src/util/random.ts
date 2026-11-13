/** `bytes` random bytes as lowercase hex. */
export function randomHex(bytes: number): string {
  const arr = new Uint8Array(bytes);
  const cryptoObj = typeof globalThis !== "undefined" ? (globalThis as any).crypto : undefined;
  if (cryptoObj && typeof cryptoObj.getRandomValues === "function") {
    cryptoObj.getRandomValues(arr);
  }
  else {
    // Non-secure contexts have no WebCrypto. These ids are collision-avoidance
    // labels, not secrets, so a weaker source is acceptable as a last resort.
    for (let i = 0; i < arr.length; i++) {
      arr[i] = Math.floor(Math.random() * 256);
    }
  }
  return Array.from(arr, (b) => b.toString(16).padStart(2, "0")).join("");
}
