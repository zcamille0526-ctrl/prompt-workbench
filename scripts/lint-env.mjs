#!/usr/bin/env node
// Forbid leaks of server-only env names into the frontend bundle.
//
// Three rules — see spec §12.4. Best-effort textual checks; residual risks
// (string concatenation, eval, globalThis['process']) are accepted in v1
// per §12.4.1, with an ESLint-AST upgrade path noted there.
//
// Cross-platform: pure Node, runs the same on Linux CI and Windows local.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const SRC = join(ROOT, "src");

const SERVER_ONLY_NAMES = ["SUPABASE_SERVICE_ROLE_KEY", "SHARED_PASSWORD", "ADMIN_EMAILS"];

// Rule 1: any literal occurrence of a server-only env name is forbidden.
const RULE_1 = new RegExp(`\\b(${SERVER_ONLY_NAMES.join("|")})\\b`);

// Rule 2: client must read only VITE_-prefixed env when touching SUPABASE / ADMIN
// / SHARED / SITE_URL families. Covers `.X` access AND bracket access with quoted
// string. Does NOT cover dynamic concatenation (residual risk, §12.4.1).
//
//   process.env.SUPABASE_URL         → fail
//   process.env["SUPABASE_URL"]      → fail
//   import.meta.env.ADMIN_EMAILS     → fail
//   import.meta.env.VITE_SUPABASE_URL → ok (negative lookahead absorbs VITE_)
const ENV_OBJ = String.raw`(?:process\.env|import\.meta\.env)`;
const FAMILIES = "SUPABASE|ADMIN|SHARED|SITE_URL";
const RULE_2_DOT = new RegExp(`${ENV_OBJ}\\.(?!VITE_)(?:${FAMILIES})`);
const RULE_2_BRACKET = new RegExp(
  `${ENV_OBJ}\\[\\s*["'](?!VITE_)(?:${FAMILIES})`
);

// Rule 3: destructuring server-only names from process.env / import.meta.env.
//   const { SUPABASE_SERVICE_ROLE_KEY } = process.env  → fail
const RULE_3 = new RegExp(
  `\\{[^}]*\\b(?:${SERVER_ONLY_NAMES.join("|")})\\b[^}]*\\}\\s*=\\s*${ENV_OBJ}`
);

const SKIP_DIRS = new Set(["node_modules", "dist", ".git"]);
const CHECK_EXT = /\.(ts|tsx|js|jsx|mjs|cjs)$/;

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    const s = statSync(p);
    if (s.isDirectory()) yield* walk(p);
    else if (CHECK_EXT.test(name)) yield p;
  }
}

let failed = false;
function fail(file, ruleNum, msg, line, col, sample) {
  failed = true;
  const rel = relative(ROOT, file);
  console.error(`[lint:env] ${rel}:${line}:${col}: rule ${ruleNum} — ${msg}`);
  console.error(`  ${sample}`);
}

function lineColOf(text, idx) {
  let line = 1;
  let col = 1;
  for (let i = 0; i < idx; i++) {
    if (text[i] === "\n") {
      line++;
      col = 1;
    } else {
      col++;
    }
  }
  return [line, col];
}

function check(file) {
  const text = readFileSync(file, "utf8");

  for (const [rule, regex, label] of [
    [1, RULE_1, "server-only env name appears in client code"],
    [2, RULE_2_DOT, "client must read only VITE_-prefixed env (dot access)"],
    [2, RULE_2_BRACKET, "client must read only VITE_-prefixed env (bracket access)"],
    [3, RULE_3, "destructured server-only env in client code"],
  ]) {
    const m = regex.exec(text);
    if (m) {
      const [line, col] = lineColOf(text, m.index);
      const sample = text.slice(Math.max(0, m.index - 20), m.index + 60).replace(/\n/g, "\\n");
      fail(file, rule, label, line, col, sample);
    }
  }
}

for (const f of walk(SRC)) check(f);

if (failed) {
  console.error("\nlint:env failed — see spec §12.4 / §12.4.1.");
  process.exit(1);
}
