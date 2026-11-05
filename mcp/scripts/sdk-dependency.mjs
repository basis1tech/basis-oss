// mcp/ depends on @basis1/parse. In the repository the dependency is
// `file:../sdk`, so mcp always builds and tests against the SDK source next
// to it. A published package must name a registry version instead, so
// release and pack steps pin it to `^<sdk/package.json version>` first.
//
//   node scripts/sdk-dependency.mjs pin   # file:../sdk -> ^0.1.0 (release workflow only)
//
// check-publishable.mjs refuses to publish while a local spec remains.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const SDK = "@basis1/parse";

export function pinnedSpec() {
  const sdk = JSON.parse(readFileSync(join(root, "..", "sdk", "package.json"), "utf8"));
  if (sdk.name !== SDK) throw new Error(`../sdk is ${sdk.name}, expected ${SDK}`);
  return `^${sdk.version}`;
}

export function isLocalSpec(spec) {
  return /^(file|link|workspace|portal):/.test(spec) || spec.startsWith(".") || spec.startsWith("/");
}

/** Rewrites package.json in place; returns the original text so callers can restore it. */
export function pin() {
  const path = join(root, "package.json");
  const original = readFileSync(path, "utf8");
  const pkg = JSON.parse(original);
  const spec = pkg.dependencies?.[SDK];
  if (!spec) throw new Error(`package.json has no ${SDK} dependency`);
  if (!isLocalSpec(spec)) return original;
  pkg.dependencies[SDK] = pinnedSpec();
  writeFileSync(path, `${JSON.stringify(pkg, null, 2)}\n`);
  return original;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] !== "pin") {
    process.stderr.write("usage: node scripts/sdk-dependency.mjs pin\n");
    process.exit(2);
  }
  pin();
  process.stdout.write(`${SDK} pinned to ${pinnedSpec()}\n`);
}
