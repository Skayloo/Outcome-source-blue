// node scripts/hooks-after-return-check.mjs
//
// One trap, three days lost across two incidents: a hook placed BELOW an early return. The
// component then has a different number of hooks depending on state, React tears the tree down
// on the transition, and the whole app goes black — looking for all the world like a broken
// deploy. CLAUDE.md warns about it; that did not stop it happening again in 1.31.27.
//
// tsc cannot see it and there is no eslint here on purpose, so this is the cheapest thing that
// can: inside a component body (two-space indentation, the style this codebase uses), a `use…`
// hook must not appear after a top-level `return`.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const HOOK = /^ {2}(?:const|let)\s+[[{\w].*=\s*use[A-Z]\w*\(/;
const HOOK_BARE = /^ {2}use[A-Z]\w*\(/;
const RETURN = /^ {2}(?:if\s*\(.*\)\s*)?return\b/;
const COMPONENT = /^export (?:default )?function [A-Z]|^function [A-Z]/;

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith(".tsx") ? [p] : [];
  });
}

const problems = [];
for (const file of walk("src")) {
  const lines = readFileSync(file, "utf8").split("\n");
  let inComponent = false;
  let returnedAt = 0;
  lines.forEach((line, i) => {
    if (COMPONENT.test(line)) { inComponent = true; returnedAt = 0; return; }
    if (line === "}") { inComponent = false; return; }
    if (!inComponent) return;
    if (returnedAt === 0 && RETURN.test(line)) returnedAt = i + 1;
    if (returnedAt !== 0 && (HOOK.test(line) || HOOK_BARE.test(line))) {
      problems.push(`${file}:${i + 1}  хук после раннего return (строка ${returnedAt}): ${line.trim().slice(0, 70)}`);
    }
  });
}

if (problems.length > 0) {
  console.error("Хуки ниже раннего возврата — приложение почернеет при смене состояния:\n");
  for (const p of problems) console.error("  " + p);
  process.exit(1);
}
console.log("hooks ok — ни одного хука ниже раннего return");
