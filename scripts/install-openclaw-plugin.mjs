#!/usr/bin/env node
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicBaseUrl = process.env.PUBLIC_BASE_URL?.replace(/\/+$/, "");
if (!publicBaseUrl || !URL.canParse(publicBaseUrl) || !publicBaseUrl.startsWith("https://")) {
  console.error("Set PUBLIC_BASE_URL to the public HTTPS URL that forwards to your OpenClaw Gateway.");
  process.exit(1);
}

const existingPaths = readJson("npx", ["openclaw", "config", "get", "plugins.load.paths", "--json"]);
const pluginPaths = Array.isArray(existingPaths) ? existingPaths.filter((item) => typeof item === "string") : [];

const patch = {
  plugins: {
    load: { paths: [...new Set([...pluginPaths, root])] },
    entries: {
      "lp-manager": {
        enabled: true,
        config: {
          cluster: "devnet",
          rpcUrl: "https://api.devnet.solana.com",
          publicBaseUrl,
          notificationsEnabled: true,
          notificationSessionKey: "agent:main:main",
        },
      },
    },
  },
  channels: { telegram: { capabilities: { inlineButtons: "dm" } } },
};

run("npx", ["openclaw", "config", "patch", "--stdin"], JSON.stringify(patch));
run("npx", ["openclaw", "plugins", "inspect", "lp-manager", "--runtime", "--json"]);
console.log("LP manager installed. Restart the existing OpenClaw Gateway.");

function run(command, args, input) {
  const result = spawnSync(command, args, { cwd: root, input, stdio: [input ? "pipe" : "inherit", "inherit", "inherit"] });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function readJson(command, args) {
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8" });
  if (result.status !== 0 || !result.stdout.trim()) return [];
  try {
    return JSON.parse(result.stdout);
  } catch {
    return [];
  }
}
