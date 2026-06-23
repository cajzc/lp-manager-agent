import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadOrCreateAgentWallet } from "../src/agent-wallet.js";
import { resolveRuntimeConfig } from "../src/runtime-config.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("runtime security configuration", () => {
  it("fails closed when mainnet is selected without the explicit switch", () => {
    expect(() =>
      resolveRuntimeConfig(
        { cluster: "mainnet-beta", publicBaseUrl: "https://agent.example.com" },
        "/tmp/openclaw",
      ),
    ).toThrow("enableMainnet=true");
  });

  it("keeps application state under the OpenClaw state directory", () => {
    const config = resolveRuntimeConfig(
      { publicBaseUrl: "https://agent.example.com/" },
      "/srv/openclaw-state",
    );
    expect(config.databasePath).toBe("/srv/openclaw-state/lp-manager/lp-manager.sqlite");
    expect(config.agentKeypairPath).toBe("/srv/openclaw-state/lp-manager/agent-keypair.json");
    expect(config.oracleQuoteMint).toBe("BRjpCHtyQLNCo8gqRUr8jtdAj5AjPYQaoqbvcZiHok1k");
    expect(config.quoteTokenLabel).toBe("USDC");
    expect(config.publicBaseUrl).toBe("https://agent.example.com");
  });

  it("creates only an agent key with private filesystem permissions", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lp-manager-wallet-"));
    dirs.push(dir);
    const filename = path.join(dir, "state", "agent-keypair.json");
    const first = loadOrCreateAgentWallet(filename);
    const second = loadOrCreateAgentWallet(filename);
    expect(second.publicKey.toBase58()).toBe(first.publicKey.toBase58());
    if (process.platform !== "win32") expect(fs.statSync(filename).mode & 0o777).toBe(0o600);
    expect(fs.existsSync(path.join(dir, "state", "user-keypair.json"))).toBe(false);
  });
});
