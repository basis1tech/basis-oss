#!/usr/bin/env node
// Bundles src/index.ts into dist/index.js, the package's only code file.
//
// - @basis1/parse stays external: it's a real runtime dependency, so the SDK
//   isn't duplicated and its fixes reach users without an MCP release.
// - @modelcontextprotocol/sdk and zod are bundled (tree-shaken). As runtime
//   dependencies they'd pull in about 90 packages on every `npx` (express,
//   hono, cors and friends, none of which a stdio server uses) and float on
//   semver ranges in a process that holds an API key. Bundled, `npx` fetches
//   two small packages and runs the exact versions we tested.
// - Bundled code is credited in dist/THIRD_PARTY_LICENSES.txt, built from the
//   bundle's metafile. The build fails if a bundled package isn't under a
//   permissive license, or if the bundle mentions the dev-only native addon.
import { build } from "esbuild";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const dist = join(root, "dist");

const PERMISSIVE = new Set(["MIT", "ISC", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "0BSD"]);

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

const result = await build({
  entryPoints: [join(root, "src/index.ts")],
  outfile: join(dist, "index.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20.19",
  external: ["@basis1/parse"],
  banner: { js: "#!/usr/bin/env node" },
  define: { __BASIS_MCP_VERSION__: JSON.stringify(pkg.version) },
  legalComments: "none",
  metafile: true,
  logLevel: "warning",
});

const bundle = readFileSync(join(dist, "index.js"), "utf8");
if (bundle.includes("basis-napi")) {
  throw new Error("dist/index.js mentions basis-napi: the dev-only native engine leaked into the published bundle");
}

// Every package that contributed code, keyed by its directory in node_modules.
const packages = new Map();
for (const input of Object.keys(result.metafile.inputs)) {
  const parts = input.split(/[\\/]/);
  const at = parts.lastIndexOf("node_modules");
  if (at === -1) continue;
  const nameParts = parts[at + 1].startsWith("@") ? parts.slice(at + 1, at + 3) : [parts[at + 1]];
  const dir = join(root, ...parts.slice(0, at + 1), ...nameParts);
  packages.set(dir, nameParts.join("/"));
}

function licenseText(dir) {
  const file = readdirSync(dir).find((f) => /^(licen[cs]e|copying)(\.|$)/i.test(f));
  return file ? readFileSync(join(dir, file), "utf8").trim() : null;
}

const sections = [];
const problems = [];
for (const [dir, name] of [...packages].sort((a, b) => a[1].localeCompare(b[1]))) {
  const meta = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  const license = typeof meta.license === "string" ? meta.license : meta.license?.type;
  if (!PERMISSIVE.has(license)) problems.push(`${name}@${meta.version} is "${license}"`);
  const text = licenseText(dir);
  if (!text) problems.push(`${name}@${meta.version} ships no LICENSE file to credit`);
  sections.push(`${name}@${meta.version} (${license})\n${"-".repeat(72)}\n${text ?? ""}\n`);
}
if (problems.length) {
  throw new Error(`bundled dependencies need attention:\n  ${problems.join("\n  ")}`);
}

writeFileSync(
  join(dist, "THIRD_PARTY_LICENSES.txt"),
  `${pkg.name}@${pkg.version} bundles the following packages into dist/index.js.\n\n${"=".repeat(72)}\n\n` +
    sections.join(`\n${"=".repeat(72)}\n\n`),
);

const kb = (Buffer.byteLength(bundle) / 1024).toFixed(1);
process.stderr.write(`built dist/index.js (${kb} KiB), bundling ${packages.size} packages: ${[...packages.values()].sort().join(", ")}\n`);
