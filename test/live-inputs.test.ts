import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchVerifiedPythPrice } from "../src/pyth-oracle.js";
import { baseUnitsToTokenAmount, tokenAmountToBaseUnits } from "../src/subscriptions-adapter.js";
import type { RuntimeConfig } from "../src/runtime-config.js";

afterEach(() => vi.unstubAllGlobals());

describe("live input validation", () => {
  it("converts user amounts without floating point rounding", () => {
    expect(tokenAmountToBaseUnits("0.000001", 6)).toBe(1n);
    expect(tokenAmountToBaseUnits("5.123456", 6)).toBe(5_123_456n);
    expect(baseUnitsToTokenAmount(5_123_456n, 6)).toBe("5.123456");
    expect(() => tokenAmountToBaseUnits("0.0000001", 6)).toThrow("more than 6 decimal places");
  });

  it("rejects a Hermes response for a different feed", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => ({
        parsed: [{ id: "11".repeat(32), price: { price: "10000000000", conf: "1000000", expo: -8, publish_time: Math.floor(Date.now() / 1000) } }],
      }),
    })));
    await expect(fetchVerifiedPythPrice(config())).rejects.toThrow("expected");
  });

  it("rejects stale oracle data", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => ({
        parsed: [{ id: "22".repeat(32), price: { price: "10000000000", conf: "1000000", expo: -8, publish_time: Math.floor(Date.now() / 1000) - 31 } }],
      }),
    })));
    await expect(fetchVerifiedPythPrice(config())).rejects.toThrow("stale");
  });
});

function config(): RuntimeConfig {
  return {
    cluster: "devnet", rpcUrl: "https://api.devnet.solana.com", publicBaseUrl: "https://agent.example.com",
    databasePath: "/tmp/unused.sqlite", agentKeypairPath: "/tmp/unused.json",
    pythHermesUrl: "https://hermes.pyth.network", pythFeedId: `0x${"22".repeat(32)}`, pythSymbol: "SOL/USD",
    oracleQuoteMint: "BRjpCHtyQLNCo8gqRUr8jtdAj5AjPYQaoqbvcZiHok1k",
    quoteTokenLabel: "devUSDC", defaultOwnerWallet: undefined, defaultWhirlpool: undefined,
    maxOracleAgeSeconds: 30, maxPoolOracleDeviationBps: 500, monitorIntervalSeconds: 30, minimumAgentSol: 0.02,
    notificationSessionKey: "agent:main:main", notificationsEnabled: true,
  };
}
