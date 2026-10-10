#!/usr/bin/env node

import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const distEntry = join(here, "..", "dist", "index.js");

// Pinned so a cold start never pulls an unreviewed `t3@latest` from npm.
const T3_CLI_VERSION = process.env.T3_CLI_VERSION?.trim() || "0.0.45";

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

async function issueToken() {
  const npx =
    process.platform === "win32"
      ? join(dirname(process.execPath), "node_modules", "npm", "bin", "npx-cli.js")
      : "npx";
  const ttl = process.env.T3_TOKEN_TTL?.trim() || "7d";
  const result = await run(process.execPath, [
    npx,
    "--yes",
    `t3@${T3_CLI_VERSION}`,
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
  const token = process.env.T3_TOKEN?.trim() || (await issueToken());
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
