// Turns what a caller hands us into a fetch body. Bytes, ArrayBuffers and
// Blobs (including File) go straight to fetch, so the client runs in browsers
// and edge runtimes. Only a string path touches the filesystem, and `node:fs`
// is loaded at that moment, never at module load. The path is opened
// as a Blob (`fs.openAsBlob`), so a large workbook is streamed from disk
// rather than read into memory, and the same body can be re-sent.

/**
 * A workbook to send: raw bytes (`Uint8Array`, which includes Node's
 * `Buffer`), an `ArrayBuffer`, a `Blob`/`File`, or, on Node only, a path.
 */
export type FileInput = Uint8Array | ArrayBuffer | Blob | string;

interface NodeFs {
  openAsBlob(path: string, options?: { type?: string }): Promise<Blob>;
}

interface NodeProcess {
  getBuiltinModule?(id: "node:fs"): NodeFs | undefined;
}

// `process.getBuiltinModule` (Node 20.16+, also Bun and Deno) loads `node:fs`
// without an import statement, so browser and edge bundlers never see a Node
// built-in and nothing is loaded for callers who pass bytes.
function loadNodeFs(): NodeFs {
  const proc = (globalThis as { process?: NodeProcess }).process;
  const fs = proc?.getBuiltinModule?.("node:fs");
  if (!fs) {
    throw new TypeError(
      "a file path was given, but this runtime has no filesystem; pass the workbook as a Uint8Array, ArrayBuffer or Blob instead",
    );
  }
  return fs;
}

export type RequestBody = Uint8Array | ArrayBuffer | Blob;

export async function toBody(input: FileInput): Promise<RequestBody> {
  if (typeof input !== "string") return input;
  const fs = loadNodeFs();
  return fs.openAsBlob(input);
}
