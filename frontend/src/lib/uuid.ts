/**
 * crypto.randomUUID() is only defined in secure contexts (HTTPS or localhost).
 * Self-hosted Outcome servers are often reached over plain HTTP on a LAN IP or
 * internal hostname, where it is undefined. This wrapper falls back to
 * getRandomValues (available in insecure contexts) and finally Math.random.
 */
export function randomUUID(): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (c && typeof c.randomUUID === "function") {
    return c.randomUUID();
  }

  const bytes = new Uint8Array(16);
  if (c && typeof c.getRandomValues === "function") {
    c.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  }

  // RFC 4122 version 4.
  const hex = [...bytes].map((value, i) => {
    let b = value;
    if (i === 6) b = (b & 0x0f) | 0x40;
    if (i === 8) b = (b & 0x3f) | 0x80;
    return b.toString(16).padStart(2, "0");
  });

  return [
    hex.slice(0, 4).join(""),
    hex.slice(4, 6).join(""),
    hex.slice(6, 8).join(""),
    hex.slice(8, 10).join(""),
    hex.slice(10, 16).join(""),
  ].join("-");
}
