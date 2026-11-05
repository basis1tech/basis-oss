#!/usr/bin/env node
// Refuses to publish while an owner decision is still open. Runs as
// `prepublishOnly`, so it guards a manual `npm publish` as well as the
// release workflow. Exits non-zero with one line per unresolved item.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const license = readFileSync(join(root, "LICENSE"), "utf8");

const problems = [];

if (license.startsWith("BASIS-SDK-LICENSE-PLACEHOLDER")) {
  problems.push("sdk/LICENSE is still the placeholder. Choose the SDK's license (#278), replace the file and set package.json \"license\".");
}
if (pkg.license === "SEE LICENSE IN LICENSE" || pkg.license === "UNLICENSED") {
  problems.push(`package.json "license" is "${pkg.license}". Set it to the chosen license's SPDX identifier.`);
}
// The @basis scope on npm belongs to another account (registry
// /-/org/basis/package answers 200 with no packages), so this name can't be
// published by us. Remove this check once the name is changed or the scope is
// confirmed ours.
if (pkg.name.startsWith("@basis/")) {
  problems.push(`package name "${pkg.name}" is in the @basis npm scope, which we don't own. Pick the published name first (#277).`);
}

if (problems.length > 0) {
  for (const p of problems) process.stderr.write(`not publishable: ${p}\n`);
  process.exit(1);
}
process.stdout.write(`${pkg.name}@${pkg.version} is publishable\n`);
