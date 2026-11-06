#!/usr/bin/env node
// Packs @basis1/mcp the way the release does (SDK dependency pinned to a
// registry range), installs it into a fresh temporary project and proves a
// user can run it: the bin starts, answers the MCP initialize handshake and
// lists its tools over stdio, both directly and through `npx`. Also checks
// the tarball holds only what we mean to ship and installs nothing beyond
// @basis1/parse.
//
// @basis1/parse may not be on npm yet, so the SDK is packed from ../sdk and
// installed alongside; it satisfies the pinned range the same way the
// registry copy will. Leaves nothing behind, and restores package.json.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { handshake } from "./handshake.mjs";
import { pin, pinnedSpec } from "./sdk-dependency.mjs";

const mcp = join(dirname(fileURLToPath(import.meta.url)), "..");
const sdk = join(mcp, "..", "sdk");
const work = mkdtempSync(join(tmpdir(), "basis-mcp-pack-"));
const EXPECTED_FILES = ["LICENSE", "README.md", "dist/THIRD_PARTY_LICENSES.txt", "dist/index.js", "package.json"];
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const npx = process.platform === "win32" ? "npx.cmd" : "npx";

function run(cmd, args, cwd) {
  // Windows can only start npm.cmd through a shell (Node refuses .cmd files otherwise).
  return execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], shell: process.platform === "win32" });
}

async function step(name, fn) {
  await fn();
  process.stdout.write(`ok  ${name}\n`);
}

function cleanEnv() {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith("BASIS_")) env[k] = v;
  return { ...env, BASIS_API_KEY: "basis_pack_smoke_key" };
}

const original = pin();
let packed;
try {
  [packed] = JSON.parse(run(npm, ["pack", "--json", "--pack-destination", work], mcp));
} finally {
  writeFileSync(join(mcp, "package.json"), original);
}

try {
  const files = packed.files.map((f) => f.path).sort();
  process.stdout.write(
    `packed ${packed.filename}: ${files.length} files, ${packed.size} bytes packed, ${packed.unpackedSize} unpacked\n` +
      `${packed.files.map((f) => `    ${f.path} (${f.size} bytes)`).join("\n")}\n`,
  );

  await step("tarball holds only the bundle, its notices, README, LICENSE and package.json", () => {
    if (JSON.stringify(files) !== JSON.stringify(EXPECTED_FILES)) {
      throw new Error(`tarball files ${files.join(", ")} != ${EXPECTED_FILES.join(", ")}`);
    }
  });

  const [sdkPacked] = JSON.parse(run(npm, ["pack", "--json", "--pack-destination", work], sdk));
  const app = join(work, "app");
  mkdirSync(app);
  writeFileSync(join(app, "package.json"), JSON.stringify({ name: "consumer", private: true }));
  run(npm, ["install", "--no-audit", "--no-fund", "--ignore-scripts", join(work, sdkPacked.filename), join(work, packed.filename)], app);

  await step(`depends only on @basis1/parse ${pinnedSpec()}, and nothing else installs`, () => {
    const manifest = JSON.parse(readFileSync(join(app, "node_modules/@basis1/mcp/package.json"), "utf8"));
    if (JSON.stringify(manifest.dependencies) !== JSON.stringify({ "@basis1/parse": pinnedSpec() })) {
      throw new Error(`unexpected dependencies: ${JSON.stringify(manifest.dependencies)}`);
    }
    const lock = JSON.parse(readFileSync(join(app, "package-lock.json"), "utf8"));
    const installed = Object.keys(lock.packages).filter((p) => p.startsWith("node_modules/")).sort();
    if (JSON.stringify(installed) !== JSON.stringify(["node_modules/@basis1/mcp", "node_modules/@basis1/parse"])) {
      throw new Error(`expected only @basis1/mcp and @basis1/parse, got: ${installed.join(", ")}`);
    }
  });

  const checkHandshake = (r) => {
    if (r.stdoutNoise.length) throw new Error(`non-protocol output on stdout: ${r.stdoutNoise.join(" | ")}`);
    const [init, list] = r.responses;
    if (init?.result?.serverInfo?.name !== "basis") throw new Error(`bad initialize: ${JSON.stringify(init)}\n${r.stderr}`);
    const tools = list?.result?.tools ?? [];
    if (tools.length !== 25) throw new Error(`expected 25 tools, got ${tools.length}\n${r.stderr}`);
    if (r.stderr.includes("basis_pack_smoke_key")) throw new Error("the API key was logged");
    return `${init.result.serverInfo.name} ${init.result.serverInfo.version}, protocol ${init.result.protocolVersion}, ${tools.length} tools`;
  };

  await step("the installed bin answers initialize and tools/list over stdio", async () => {
    const bin = join(app, "node_modules/.bin", process.platform === "win32" ? "basis-mcp.cmd" : "basis-mcp");
    const r = await handshake(bin, [], { cwd: app, env: cleanEnv() });
    process.stdout.write(`    ${checkHandshake(r)}\n`);
  });

  await step("`npx @basis1/mcp` starts the same server", async () => {
    const r = await handshake(npx, ["--no-install", "@basis1/mcp"], { cwd: app, env: cleanEnv(), timeoutMs: 60_000 });
    process.stdout.write(`    ${checkHandshake(r)}\n`);
  });

  await step("the shipped bundle never mentions the dev-only native engine", () => {
    const js = readFileSync(join(app, "node_modules/@basis1/mcp/dist/index.js"), "utf8");
    if (js.includes("basis-napi") || js.includes(".node\"")) throw new Error("dist/index.js references a native addon");
  });

  process.stdout.write("pack smoke passed\n");
} finally {
  rmSync(work, { recursive: true, force: true });
}
