#!/usr/bin/env node
// Refuses to publish a package that would install badly or ship the wrong
// thing. Runs as `prepublishOnly` (so it guards a manual `npm publish` too)
// and in the release workflow. Mirrors sdk/scripts/check-publishable.mjs:
// one line per problem on stderr, exit 1.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isLocalSpec } from "./sdk-dependency.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const license = readFileSync(join(root, "LICENSE"), "utf8");

const problems = [];

if (pkg.license !== "Apache-2.0" || !license.includes("Apache License") || !license.includes("Version 2.0, January 2004")) {
  problems.push('package.json "license" must be "Apache-2.0" with the Apache 2.0 text in LICENSE.');
}
if (pkg.name.startsWith("@basis/")) {
  problems.push(`package name "${pkg.name}" is in the @basis npm scope, which we don't own.`);
}
for (const [name, spec] of Object.entries(pkg.dependencies ?? {})) {
  if (isLocalSpec(spec)) problems.push(`dependency ${name} is "${spec}". Run node scripts/sdk-dependency.mjs pin first.`);
}
const deps = Object.keys(pkg.dependencies ?? {});
if (deps.length !== 1 || deps[0] !== "@basis1/parse") {
  problems.push(`runtime dependencies should be exactly @basis1/parse (got ${deps.join(", ") || "none"}); everything else is bundled.`);
}
// Registered under the product domain, not a personal GitHub namespace; the
// MCP Registry verifies tech.basis1/* through a DNS TXT record on basis1.tech.
if (pkg.mcpName && !pkg.mcpName.startsWith("tech.basis1/")) {
  problems.push(`mcpName ${pkg.mcpName} should be under tech.basis1/ (verified by DNS on basis1.tech).`);
}
const manifest = JSON.parse(readFileSync(join(root, "server.json"), "utf8"));
if (manifest.name !== pkg.mcpName || manifest.version !== pkg.version || manifest.packages?.[0]?.version !== pkg.version) {
  problems.push("server.json name/version must match package.json mcpName/version.");
}
if (!existsSync(join(root, "dist", "index.js"))) problems.push("dist/index.js is missing; run npm run build.");

if (problems.length > 0) {
  for (const p of problems) process.stderr.write(`not publishable: ${p}\n`);
  process.exit(1);
}
process.stdout.write(`${pkg.name}@${pkg.version} is publishable\n`);
