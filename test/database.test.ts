import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProductionDatabase, type ExecutionRecord, type Mandate, type MandateRequest, type Strategy } from "../src/production-database.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("production database invariants", () => {
  it("stores token amounts as exact integer strings and rejects duplicate execution keys", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lp-manager-db-"));
    dirs.push(dir);
    const db = new ProductionDatabase(path.join(dir, "state.sqlite"));
    const mandate: Mandate = {
      id: "delegation", userWallet: "owner", agentWallet: "agent", mint: "mint", tokenProgram: "program",
      userAta: "user-ata", agentAta: "agent-ata", capBaseUnits: "900719925474099312345",
      amountPulledBaseUnits: "0", periodSeconds: 604800, startTs: 1, expiryTs: 9999999999,
      status: "active", updatedAt: new Date().toISOString(),
    };
    db.upsertMandate(mandate);
    expect(db.getActiveMandate()?.capBaseUnits).toBe("900719925474099312345");
    const strategy: Strategy = {
      id: "strategy", mandateId: mandate.id, whirlpool: "pool", inputMint: "mint", rangeWidthBps: 600,
      rebalanceEdgeBps: 75, slippageBps: 100, deployFractionBps: 5000, minimumScore: 70,
      status: "active", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    db.upsertStrategy(strategy);
    const execution: ExecutionRecord = {
      id: "execution-1", strategyId: strategy.id, mandateId: mandate.id, idempotencyKey: "period-1",
      trigger: "test", action: "deploy", state: "planned", amountBaseUnits: "123456789012345678",
      reason: "test invariant", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    expect(db.insertExecution(execution)).toBe(true);
    db.updateExecution(execution.id, {
      state: "swap_confirmed",
      swapSignature: "swap-signature",
      tokenAAllocationBaseUnits: "42",
      tokenBAllocationBaseUnits: "84",
    });
    expect(db.getRecoverableExecution(strategy.id)).toMatchObject({
      state: "swap_confirmed",
      swapSignature: "swap-signature",
      tokenAAllocationBaseUnits: "42",
      tokenBAllocationBaseUnits: "84",
    });
    expect(db.insertExecution({ ...execution, id: "execution-2" })).toBe(false);
    db.close();
  });

  it("stores one durable follow-up for an initialized Action request", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lp-manager-db-"));
    dirs.push(dir);
    const db = new ProductionDatabase(path.join(dir, "state.sqlite"));
    const base: MandateRequest = {
      id: "initialize", type: "initialize", status: "pending", userWallet: "owner", agentWallet: "agent",
      mint: "mint", tokenProgram: "program", userAta: "user-ata", agentAta: "agent-ata",
      actionUrl: "https://example.test/initialize", createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    db.insertMandateRequest(base);
    db.insertMandateRequest({ ...base, id: "create", type: "create", parentRequestId: base.id, actionUrl: "https://example.test/create" });
    expect(db.getFollowUpMandateRequest(base.id)?.id).toBe("create");
    expect(() => db.insertMandateRequest({ ...base, id: "duplicate", type: "create", parentRequestId: base.id })).toThrow();
    db.close();
  });
});
