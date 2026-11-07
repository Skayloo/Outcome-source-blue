// Runs lib/loginKey.ts against ServerDotnet/tools/LoginKeyCheck/vectors.json — the vectors the
// server's own code and the app are checked against too. A derivation that drifts here would sign
// nobody in. `node --experimental-strip-types scripts/login-key-check.mjs`; exit code is the verdict.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { deriveLoginKey, legacyProof, passwordProblem, LegacyUnsupportedError, LoginParamsRefusedError } from "../src/lib/loginKey.ts";

const here = dirname(fileURLToPath(import.meta.url));
const vectors = JSON.parse(readFileSync(join(here, "../../ServerDotnet/tools/LoginKeyCheck/vectors.json"), "utf8"));
let fails = 0;
const check = (ok, what) => { console.log(`${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) fails++; };
const throwsAsync = async (fn, type) => { try { await fn(); return false; } catch (e) { return e instanceof type; } };

for (const v of vectors.login)
  check(await deriveLoginKey(v.password, v.salt, v.iterations) === v.key, `login key (${v.password}, ${v.iterations})`);

for (const v of vectors.legacy) {
  if (v.legacy.kind === "unsupported") {
    check(await throwsAsync(() => legacyProof(v.password, v.legacy), LegacyUnsupportedError), `refused: ${v.note}`);
    continue;
  }
  check(await legacyProof(v.password, v.legacy) === v.proof, `legacy proof: ${v.note}`);
  check(await legacyProof(v.password + "x", v.legacy) !== v.proof, `wrong password differs: ${v.note}`);
}

// A server cannot talk the page into a cheap key.
const salt = vectors.login[0].salt;
check(await throwsAsync(() => deriveLoginKey("x", salt, 599_999), LoginParamsRefusedError), "too few iterations refused");
check(await throwsAsync(() => deriveLoginKey("x", salt, 5_000_001), LoginParamsRefusedError), "too many iterations refused");
check(await throwsAsync(() => deriveLoginKey("x", btoa("short"), 600_000), LoginParamsRefusedError), "short salt refused");
const argon = vectors.legacy.find((v) => v.legacy.kind === "argon2id").legacy;
check(await throwsAsync(() => legacyProof("x", { ...argon, m: 4096 }), LoginParamsRefusedError), "weak argon2id refused");
const pb = vectors.legacy.find((v) => v.legacy.kind === "pbkdf2").legacy;
check(await throwsAsync(() => legacyProof("x", { ...pb, iterations: 1000 }), LoginParamsRefusedError), "weak pbkdf2 refused");

// The server's old password rules, now checked here only.
check(passwordProblem("Short1") === "password must be at least 8 characters", "rule: length");
check(passwordProblem("alllower1") === "password must contain an uppercase letter", "rule: upper");
check(passwordProblem("ALLUPPER1") === "password must contain a lowercase letter", "rule: lower");
check(passwordProblem("NoDigitsHere") === "password must contain a digit", "rule: digit");
check(passwordProblem("Пароль-йо 2026") === null, "rule: Cyrillic passes");
check(passwordProblem("Aa1" + "ж".repeat(35)) === "password must not exceed 72 characters", "rule: 72 bytes");

console.log(fails === 0 ? "ALL PASSED" : `${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
