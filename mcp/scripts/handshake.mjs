// Launches an MCP stdio server and talks to it the way a client does:
// initialize, notifications/initialized, then any further requests. Raw
// JSON-RPC on purpose (no SDK), so it also proves stdout carries nothing but
// protocol messages: any other line on stdout fails the run.
//
// Used by test/stdio.test.ts against dist/index.js and by pack-smoke.mjs
// against the installed bin.
import { spawn } from "node:child_process";

export const PROTOCOL_VERSION = "2025-06-18";

/**
 * @param {string} command
 * @param {string[]} args
 * @param {{ env?: Record<string, string | undefined>, cwd?: string, requests?: Array<{method: string, params?: unknown}>, timeoutMs?: number }} [opts]
 * @returns {Promise<{ responses: any[], stderr: string, stdoutNoise: string[], code: number | null }>}
 */
export function handshake(command, args, opts = {}) {
  const requests = [
    {
      method: "initialize",
      params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "basis-handshake", version: "1" } },
    },
    ...(opts.requests ?? [{ method: "tools/list" }]),
  ];
  return new Promise((resolve, reject) => {
    // Windows starts .cmd shims (npx.cmd, the installed bin) only through a shell.
    const shell = process.platform === "win32" && /\.cmd$/i.test(command);
    const child = spawn(command, args, { cwd: opts.cwd, env: opts.env ?? process.env, stdio: ["pipe", "pipe", "pipe"], shell });
    const responses = [];
    const stdoutNoise = [];
    let stderr = "";
    let buf = "";
    let next = 0;
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`handshake timed out after ${responses.length} responses; stderr:\n${stderr}`));
    }, opts.timeoutMs ?? 20_000);

    const send = (msg) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...msg })}\n`);
    const sendNext = () => {
      if (next >= requests.length) {
        child.stdin.end();
        return;
      }
      const id = next + 1;
      send({ id, ...requests[next] });
      next++;
    };

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          stdoutNoise.push(line);
          continue;
        }
        if (msg.id === undefined) continue; // a notification from the server
        responses.push(msg);
        if (msg.id === 1) send({ method: "notifications/initialized" });
        sendNext();
      }
    });
    // A server that refuses to start exits before reading; that's a result, not a crash.
    child.stdin.on("error", () => {});
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (buf.trim()) stdoutNoise.push(buf.trim());
      resolve({ responses, stderr, stdoutNoise, code });
    });
    sendNext();
  });
}
