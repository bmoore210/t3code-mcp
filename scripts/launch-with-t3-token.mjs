#!/usr/bin/env node

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const distEntry = join(here, "..", "dist", "index.js");
const runtimePath = join(homedir(), ".t3", "userdata", "server-runtime.json");

// Pinned so a cold start never pulls an unreviewed `t3@latest` from npm.
const T3_CLI_VERSION = process.env.T3_CLI_VERSION?.trim() || "0.0.45";

function t3Origin() {
  if (process.env.T3_ORIGIN) return process.env.T3_ORIGIN.replace(/\/$/, "");
  try {
    const origin = JSON.parse(readFileSync(runtimePath, "utf8")).origin;
    return typeof origin === "string" ? origin.replace(/\/$/, "") : null;
  } catch {
    return null;
  }
}

// Minting is gated on a live server so a start that cannot succeed does not
// leave a seven-day token behind; MCP hosts retry failed starts many times.
async function assertT3Reachable() {
  const origin = t3Origin();
  if (!origin) {
    throw new Error(`T3 Code is not running (${runtimePath} not found). Start it, or set T3_ORIGIN.`);
  }
  try {
    const res = await fetch(`${origin}/.well-known/t3/environment`, {
      signal: AbortSignal.timeout(3_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (error) {
    throw new Error(`T3 Code at ${origin} is not responding (${error.message}). Start it before launching.`);
  }
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

// The installed devDependency starts in well under a second; npx is only a
// fallback for a checkout without node_modules, and it can take minutes on a
// cold cache, longer than MCP hosts wait for a server to start.
function t3CliArgs() {
  const local = join(here, "..", "node_modules", "t3", "bin", "t3.js");
  if (existsSync(local)) return [local];
  const npx =
    process.platform === "win32"
      ? join(dirname(process.execPath), "node_modules", "npm", "bin", "npx-cli.js")
      : "npx";
  return [npx, "--yes", `t3@${T3_CLI_VERSION}`];
}

async function issueToken() {
  const ttl = process.env.T3_TOKEN_TTL?.trim() || "7d";
  const result = await run(process.execPath, [
    ...t3CliArgs(),
    "auth",
    "session",
    "issue",
    "--json",
    "--label",
    "t3code-mcp",
    "--ttl",
    ttl,
  ]);
  if (result.code !== 0) {
    throw new Error(`T3 session token issuance failed (exit ${result.code ?? "unknown"}).`);
  }
  let payload;
  try {
    payload = JSON.parse(result.stdout.trim());
  } catch {
    throw new Error("T3 session token issuance returned an invalid response.");
  }
  if (typeof payload?.token !== "string" || payload.token.trim() === "") {
    throw new Error("T3 session token issuance returned no token.");
  }
  return payload.token.trim();
}

async function main() {
  let token = process.env.T3_TOKEN?.trim();
  if (!token) {
    await assertT3Reachable();
    token = await issueToken();
  }
  const child = spawn(process.execPath, [distEntry], {
    env: { ...process.env, T3_TOKEN: token },
    stdio: "inherit",
    windowsHide: true,
  });
  child.on("error", (error) => {
    console.error(`t3code-mcp failed to start: ${error.message}`);
    process.exitCode = 1;
  });
  child.on("close", (code, signal) => {
    process.exitCode = code ?? (signal ? 1 : 0);
  });
}

main().catch((error) => {
  console.error(`t3code-mcp launcher failed: ${error.message}`);
  process.exitCode = 1;
});
