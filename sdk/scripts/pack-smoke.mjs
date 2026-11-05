#!/usr/bin/env node
// Packs the SDK, installs the tarball into a fresh temporary project and
// proves a customer can use it: ESM import, CommonJS require (Node's
// require(esm)), and a TypeScript consumer typechecking against the shipped
// .d.ts under both `nodenext` and `bundler` resolution. Also checks the
// tarball holds only what we mean to ship. Leaves nothing behind.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const sdk = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(sdk, "package.json"), "utf8"));
const tsc = join(sdk, "node_modules/typescript/bin/tsc");
const work = mkdtempSync(join(tmpdir(), "basis-sdk-pack-"));

function run(cmd, args, cwd) {
  return execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
}

function step(name, fn) {
  fn();
  process.stdout.write(`ok  ${name}\n`);
}

try {
  const [packed] = JSON.parse(run("npm", ["pack", "--json", "--pack-destination", work], sdk));
  const files = packed.files.map((f) => f.path).sort();
  process.stdout.write(`packed ${packed.filename}: ${files.length} files, ${packed.size} bytes\n${files.map((f) => `    ${f}`).join("\n")}\n`);

  step("tarball holds only dist, README, LICENSE and package.json", () => {
    const unexpected = files.filter(
      (f) => !/^dist\/[a-z]+\.(js|d\.ts)$/.test(f) && !["LICENSE", "README.md", "package.json"].includes(f),
    );
    if (unexpected.length) throw new Error(`unexpected files in tarball: ${unexpected.join(", ")}`);
    for (const needed of ["dist/index.js", "dist/index.d.ts", "LICENSE", "README.md"]) {
      if (!files.includes(needed)) throw new Error(`missing ${needed}`);
    }
  });

  const app = join(work, "app");
  run("mkdir", ["-p", app], work);
  writeFileSync(join(app, "package.json"), JSON.stringify({ name: "consumer", private: true, type: "module" }));
  run("npm", ["install", "--no-audit", "--no-fund", "--ignore-scripts", join(work, packed.filename)], app);

  step("installs with no runtime dependencies", () => {
    const lock = JSON.parse(readFileSync(join(app, "package-lock.json"), "utf8"));
    const installed = Object.keys(lock.packages).filter((p) => p.startsWith("node_modules/"));
    if (installed.length !== 1) throw new Error(`expected only the SDK, got: ${installed.join(", ")}`);
  });

  const name = pkg.name;
  const exercise = `
    const fetch = async (url) => new Response(url.endsWith("/healthz") ? "ok" : '{"type":"workbook_meta"}\\n');
    const basis = new Basis({ token: "k", baseUrl: "https://example.test", fetch });
    if ((await basis.healthz()) !== true) throw new Error("healthz");
    const records = await basis.parse(new Uint8Array([1]));
    if (records[0].type !== "workbook_meta") throw new Error("parse");
    if (!(new BasisError("x", "timeout") instanceof Error)) throw new Error("BasisError");
    if (typeof verifyWebhookSignature !== "function" || typeof diffRecords !== "function") throw new Error("exports");
  `;

  step("ESM import works", () => {
    writeFileSync(join(app, "esm.mjs"), `import { Basis, BasisError, verifyWebhookSignature, diffRecords } from "${name}";\n${exercise}`);
    run("node", ["esm.mjs"], app);
  });

  step("CommonJS require works", () => {
    writeFileSync(
      join(app, "cjs.cjs"),
      `const { Basis, BasisError, verifyWebhookSignature, diffRecords } = require("${name}");\n(async () => {${exercise}})().catch((e) => { console.error(e); process.exit(1); });`,
    );
    run("node", ["--no-warnings", "cjs.cjs"], app);
  });

  const consumer = `
    import { Basis, BasisError, type StreamRecord, type BasisErrorCode, type LibrarySaveResult } from "${name}";
    const basis = new Basis({ token: "basis_live_x", timeoutMs: 30_000, retry: { maxRetries: 2 } });
    export async function main(signal: AbortSignal): Promise<number> {
      let cells = 0;
      for await (const r of basis.parseStream(new Uint8Array(), { signal, mode: "sync" })) {
        if (r.type === "cell") cells++;
        if (r.type === "audit" && r.finding === "plug_summary") cells += r.by_kind.formula_deviation;
      }
      const saved: LibrarySaveResult = await basis.saveToLibrary(new Blob([]), { name: "x" });
      return cells + (saved.noop ? 0 : 1);
    }
    export function handle(err: unknown): BasisErrorCode | undefined {
      if (!(err instanceof BasisError)) return undefined;
      if (err.code === "quota_exceeded") return err.quota ? "quota_exceeded" : undefined;
      if (err.code === "rate_limited") return (err.retryAfter ?? 0) > 0 ? "rate_limited" : undefined;
      return err.code;
    }
    export const sample: StreamRecord = { type: "image_summary", total_images: 0, total_bytes: 0, inlined: 0 };
  `;
  writeFileSync(join(app, "consumer.ts"), consumer);
  // The same code as a CommonJS module: TypeScript 5.8+ under nodenext types
  // `require()` of an ES module, matching Node's require(esm).
  writeFileSync(join(app, "consumer-cjs.cts"), consumer);

  for (const [resolution, module] of [["nodenext", "nodenext"], ["bundler", "esnext"]]) {
    step(`TypeScript consumer typechecks (${resolution === "nodenext" ? "nodenext, ESM and CJS" : "bundler"}, no @types/node)`, () => {
      const config = {
        compilerOptions: {
          target: "ES2022",
          module,
          moduleResolution: resolution,
          lib: ["ES2022", "DOM", "DOM.AsyncIterable"],
          types: [],
          strict: true,
          noEmit: true,
          skipLibCheck: false,
        },
        files: resolution === "nodenext" ? ["consumer.ts", "consumer-cjs.cts"] : ["consumer.ts"],
      };
      writeFileSync(join(app, "tsconfig.json"), JSON.stringify(config));
      run("node", [tsc, "-p", "tsconfig.json"], app);
    });
  }

  step("the shipped JS never imports a Node built-in", () => {
    const dist = join(app, "node_modules", ...name.split("/"), "dist");
    for (const f of files.filter((p) => p.endsWith(".js"))) {
      const js = readFileSync(join(dist, f.slice("dist/".length)), "utf8");
      if (/\bfrom\s+["']node:|\bimport\(\s*["']node:|require\(\s*["']node:/.test(js)) throw new Error(`${f} imports a Node built-in`);
    }
  });

  process.stdout.write("pack smoke passed\n");
} finally {
  rmSync(work, { recursive: true, force: true });
}
