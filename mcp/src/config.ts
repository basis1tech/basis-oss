// Startup configuration, read from the environment once. Pure: takes an env
// object and returns either a config or the list of problems, so the entry
// point decides how to report them (stderr, exit 1) and tests can cover every
// case without spawning a process. The API key never appears in a message.

export const DEFAULT_BASE_URL = "https://api.basis1.tech";
export const DEFAULT_MAX_FETCH_BYTES = 200_000_000;

export interface Config {
  apiKey: string | undefined;
  /** Which variable the key came from, for the startup line (never the key). */
  apiKeySource: "BASIS_API_KEY" | "BASIS_TOKEN" | undefined;
  baseUrl: string;
  /** The hosted MCP endpoint, derived from baseUrl. */
  mcpUrl: string;
  maxFetchBytes: number;
  warnings: string[];
}

export type ConfigResult = { ok: true; config: Config } | { ok: false; errors: string[] };

type Env = Readonly<Record<string, string | undefined>>;

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

function readKey(env: Env, warnings: string[]): Pick<Config, "apiKey" | "apiKeySource"> {
  const key = env.BASIS_API_KEY?.trim();
  if (key) return { apiKey: key, apiKeySource: "BASIS_API_KEY" };
  const legacy = env.BASIS_TOKEN?.trim();
  if (legacy) {
    warnings.push("BASIS_TOKEN is deprecated; rename it to BASIS_API_KEY.");
    return { apiKey: legacy, apiKeySource: "BASIS_TOKEN" };
  }
  return { apiKey: undefined, apiKeySource: undefined };
}

function readBaseUrl(env: Env, errors: string[]): string {
  const raw = env.BASIS_BASE_URL?.trim();
  if (!raw) return DEFAULT_BASE_URL;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    errors.push(`BASIS_BASE_URL is not a valid URL: "${raw}". Use something like ${DEFAULT_BASE_URL}.`);
    return DEFAULT_BASE_URL;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    errors.push(`BASIS_BASE_URL must start with https:// (got ${url.protocol}).`);
    return DEFAULT_BASE_URL;
  }
  // The API key travels in a header on every request: plain http is only
  // acceptable when it never leaves the machine.
  if (url.protocol === "http:" && !LOOPBACK_HOSTS.has(url.hostname)) {
    errors.push(`BASIS_BASE_URL must use https:// unless it points at localhost (got ${url.host}); your API key would be sent unencrypted.`);
    return DEFAULT_BASE_URL;
  }
  if (url.username || url.password || url.search || url.hash) {
    errors.push("BASIS_BASE_URL must be a plain base URL, without credentials, a query string or a fragment.");
    return DEFAULT_BASE_URL;
  }
  return trimTrailingSlashes(url.toString());
}

// Drops trailing slashes. A loop, not /\/+$/: that regex backtracks
// quadratically on long runs of slashes (CodeQL js/polynomial-redos).
function trimTrailingSlashes(s: string): string {
  let end = s.length;
  while (end > 0 && s.charCodeAt(end - 1) === 47) end--;
  return s.slice(0, end);
}

function readMaxFetchBytes(env: Env, errors: string[]): number {
  const raw = env.BASIS_MCP_MAX_FETCH_BYTES?.trim();
  if (!raw) return DEFAULT_MAX_FETCH_BYTES;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n <= 0) {
    errors.push(`BASIS_MCP_MAX_FETCH_BYTES must be a positive whole number of bytes (got "${raw}").`);
    return DEFAULT_MAX_FETCH_BYTES;
  }
  return n;
}

export function loadConfig(env: Env): ConfigResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const key = readKey(env, warnings);
  const baseUrl = readBaseUrl(env, errors);
  const maxFetchBytes = readMaxFetchBytes(env, errors);
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    config: { ...key, baseUrl, mcpUrl: `${baseUrl}/mcp`, maxFetchBytes, warnings },
  };
}

/** The message every tool that needs the API returns when no key is set. */
export const MISSING_KEY_MESSAGE =
  "No Basis API key is set. Add BASIS_API_KEY to this server's env in your MCP client config " +
  "(get a key at https://api.basis1.tech), then restart the client.";
