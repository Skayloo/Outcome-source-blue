// Sign-in without the password ("login v2").
//
// The password never leaves this page. What the server gets instead is a login key made from it
// here (ServerDotnet/Shared/Outcome.Abstractions/Security/LoginKeys.cs has the whole scheme):
//
//   master    = PBKDF2-HMAC-SHA256(utf8(password), salt, iterations)          → 32 bytes
//   login key = HKDF-SHA256(ikm = master, salt = empty, info = "outcome/login/v2") → 32 bytes
//
// The salt and iteration count come from POST /auth/prelogin. An account made before login v2
// answers with `legacy` instead: how its old hash was made, so this page can compute that same hash
// and prove the password without sending it, together with a fresh credential the account moves to.
//
// The same constants live in the server, the app (mobile/lib/services/login_key.dart) and
// ServerDotnet/tools/LoginKeyCheck/vectors.json, which scripts/login-key-check.mjs runs this file
// against. Change one, change all four.

export const LOGIN_ITERATIONS = 600_000;
// Bounds this page holds a server to: fewer iterations would hand it a cheap key to guess at,
// absurdly many would freeze the sign-in screen.
const MIN_ITERATIONS = 600_000;
const MAX_ITERATIONS = 5_000_000;
const SALT_BYTES = 16;
const INFO = new TextEncoder().encode("outcome/login/v2");

/** How an account made before login v2 had its password hashed (the server's LoginKeys.Legacy). */
export interface LegacyHash {
  kind: "argon2id" | "pbkdf2" | "unsupported";
  salt?: string | null;
  length?: number | null;
  m?: number | null;
  t?: number | null;
  p?: number | null;
  prf?: "sha256" | "sha512" | null;
  iterations?: number | null;
}

export interface PreloginAnswer {
  salt: string;
  iterations: number;
  legacy?: LegacyHash | null;
}

/** What the server stores when a password is set: never the password. */
export interface LoginCredential {
  salt: string;
  iterations: number;
  key: string;
}

/** An account whose old hash is too weak to recompute safely: its password is reset by mail. */
export class LegacyUnsupportedError extends Error {
  constructor() {
    super("this account's password has to be reset before it can sign in here");
    this.name = "LegacyUnsupportedError";
  }
}

/** The server asked for something this page refuses to compute (see the bounds above). */
export class LoginParamsRefusedError extends Error {
  constructor(what: string) {
    super(`refused sign-in parameters: ${what}`);
    this.name = "LoginParamsRefusedError";
  }
}

function b64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function unb64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function pbkdf2(password: string, salt: Uint8Array, iterations: number, hash: "SHA-256" | "SHA-512", bytes: number): Promise<Uint8Array> {
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(password) as BufferSource, "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt: salt as BufferSource, iterations, hash }, base, bytes * 8);
  return new Uint8Array(bits);
}

/** The login key for `password` with this account's salt and iteration count. */
export async function deriveLoginKey(password: string, salt: string, iterations: number): Promise<string> {
  if (!Number.isInteger(iterations) || iterations < MIN_ITERATIONS || iterations > MAX_ITERATIONS)
    throw new LoginParamsRefusedError(`iterations ${iterations}`);
  const saltBytes = unb64(salt);
  if (saltBytes.length !== SALT_BYTES) throw new LoginParamsRefusedError("salt length");
  const master = await pbkdf2(password, saltBytes, iterations, "SHA-256", 32);
  const ikm = await crypto.subtle.importKey("raw", master as BufferSource, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0) as BufferSource, info: INFO as BufferSource }, ikm, 256);
  return b64(new Uint8Array(bits));
}

/** A fresh credential for a password being set: a new salt, today's iteration count. */
export async function newCredential(password: string): Promise<LoginCredential> {
  const salt = b64(crypto.getRandomValues(new Uint8Array(SALT_BYTES)));
  return { salt, iterations: LOGIN_ITERATIONS, key: await deriveLoginKey(password, salt, LOGIN_ITERATIONS) };
}

/**
 * The old hash of `password`, as the server stored it before login v2 — the proof that moves the
 * account. Weak parameters are refused (a hostile server would use them to get a cheap hash).
 */
export async function legacyProof(password: string, legacy: LegacyHash): Promise<string> {
  if (legacy.kind === "unsupported" || !legacy.salt) throw new LegacyUnsupportedError();
  const salt = unb64(legacy.salt);
  const length = legacy.length ?? 32;
  if (salt.length < 8 || length < 16 || length > 64) throw new LoginParamsRefusedError("legacy shape");
  if (legacy.kind === "argon2id") {
    const m = legacy.m ?? 0, t = legacy.t ?? 0, p = legacy.p ?? 0;
    if (m < 19_456 || m > 262_144 || t < 2 || t > 10 || p < 1 || p > 8) throw new LoginParamsRefusedError("legacy argon2id");
    // Loaded only for this one-time move: most visitors never need it.
    const { argon2id } = await import("hash-wasm");
    const out = await argon2id({
      password: new TextEncoder().encode(password), salt,
      memorySize: m, iterations: t, parallelism: p, hashLength: length, outputType: "binary",
    });
    return b64(out);
  }
  const iterations = legacy.iterations ?? 0;
  if (iterations < 100_000 || iterations > 10_000_000 || (legacy.prf !== "sha256" && legacy.prf !== "sha512"))
    throw new LoginParamsRefusedError("legacy pbkdf2");
  return b64(await pbkdf2(password, salt, iterations, legacy.prf === "sha512" ? "SHA-512" : "SHA-256", length));
}

/** What /auth/login (and /auth/upgrade) get for this password, given the prelogin answer. */
export async function proofFor(password: string, pre: PreloginAnswer):
  Promise<{ auth_key: string } | { legacy_proof: string; credential: LoginCredential }> {
  if (pre.legacy) {
    const [proof, credential] = await Promise.all([legacyProof(password, pre.legacy), newCredential(password)]);
    return { legacy_proof: proof, credential };
  }
  return { auth_key: await deriveLoginKey(password, pre.salt, pre.iterations) };
}

/**
 * The rules a new password has to meet — the server's old AuthRules.ValidatePassword, word for
 * word, because the server no longer sees the password to check it. Null when it is fine.
 */
export function passwordProblem(password: string): string | null {
  const bytes = new TextEncoder().encode(password).length;
  if (bytes < 8) return "password must be at least 8 characters";
  if (bytes > 72) return "password must not exceed 72 characters";
  if (!/\p{Lu}/u.test(password)) return "password must contain an uppercase letter";
  if (!/\p{Ll}/u.test(password)) return "password must contain a lowercase letter";
  if (!/\p{Nd}/u.test(password)) return "password must contain a digit";
  return null;
}
