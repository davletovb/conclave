#!/usr/bin/env node
// The hosted app runs the orchestration engine in the browser, so the web entry point reaches into
// apps/server for the orchestrator, the state store and the run manager. Those modules must stay free of Node
// built-ins: one `node:fs` import anywhere in that graph builds locally and then breaks the Cloudflare Pages
// bundle. This walks the import graph from the web entry and fails, naming the path, if it finds one.
import { readFileSync, existsSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const entries = [join(root, "apps/web/src/main.tsx")];
const workspace = { "@conclave/core": join(root, "packages/core/src/index.ts") };
const builtins = new Set([...builtinModules, ...builtinModules.map(name => `node:${name}`)]);
// Specifiers written in the source, as `import ... from "x"`, `export ... from "x"`, `import "x"` and `import("x")`.
const specifiers = source => [...source.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)["']([^"']+)["']/g)].map(match => match[1]);
const candidates = base => {
  const stem = base.replace(/\.(m?js|cjs)$/, "");
  return [base, `${stem}.ts`, `${stem}.tsx`, `${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")];
};
const resolveSpecifier = (from, specifier) => {
  if (workspace[specifier]) return workspace[specifier];
  if (!specifier.startsWith(".")) return undefined;
  return candidates(resolve(dirname(from), specifier)).find(file => /\.tsx?$/.test(file) && existsSync(file));
};

const seen = new Map(); // file -> the file that first reached it
const problems = [];
const queue = entries.map(file => [file, undefined]);
while (queue.length) {
  const [file, via] = queue.pop();
  if (seen.has(file)) continue;
  seen.set(file, via);
  // Test files are not part of the bundle.
  const source = readFileSync(file, "utf8");
  for (const specifier of specifiers(source)) {
    if (builtins.has(specifier)) {
      const chain = [];
      for (let at = file; at; at = seen.get(at)) chain.unshift(relative(root, at));
      problems.push(`${relative(root, file)} imports the Node built-in "${specifier}" (reached: ${chain.join(" -> ")})`);
      continue;
    }
    const next = resolveSpecifier(file, specifier);
    if (next && !/\.test\.tsx?$/.test(next)) queue.push([next, file]);
  }
}
if (problems.length) {
  console.error(`The web bundle would include Node-only code:\n  ${problems.join("\n  ")}`);
  process.exit(1);
}
console.log(`Web bundle boundary OK: ${seen.size} modules reachable from the web entry, none import Node built-ins`);
