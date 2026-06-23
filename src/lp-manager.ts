import { randomUUID } from "node:crypto";
import { Decimal } from "decimal.js";
import { getMint, NATIVE_MINT } from "@solana/spl-token";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { fetchVerifiedPythPrice } from "./pyth-oracle.js";
import {
  OrcaAgentKitAdapter,
  OrcaPositionOpenError,
  type LiveOrcaPosition,
} from "./orca-agentkit-plugin.js";
import {
  ProductionDatabase,
  type ExecutionRecord,
  type MandateRequest,
  type PositionRecord,
  type Strategy,
} from "./production-database.js";
import type { RuntimeConfig } from "./runtime-config.js";
import {
  baseUnitsToTokenAmount,
  SubscriptionsAdapter,
} from "./subscriptions-adapter.js";

export class LpManager {
  readonly db: ProductionDatabase;
  readonly payments: SubscriptionsAdapter;
  readonly orca: OrcaAgentKitAdapter;
  private readonly connection: Connection;
  private running = false;

  constructor(
    readonly config: RuntimeConfig,
    readonly agentWallet: Keypair,
  ) {
    this.db = new ProductionDatabase(config.databasePath);
    this.payments = new SubscriptionsAdapter(config, agentWallet);
    this.orca = new OrcaAgentKitAdapter(config, agentWallet);
    this.connection = new Connection(config.rpcUrl, "confirmed");
  }

  close(): void {
    this.db.close();
  }

  async getStatus() {
    let mandate = this.db.getActiveMandate();
    if (mandate) {
      mandate = await this.payments.reconcileMandate(mandate);
      this.db.upsertMandate(mandate);
    }
    const strategy = this.db.getActiveStrategy();
    const livePositions = strategy ? await this.reconcilePositions(strategy) : [];
    const oracle = strategy ? await fetchVerifiedPythPrice(this.config).catch((error) => ({ error: message(error) })) : undefined;
    const solBalance = await this.connection.getBalance(this.agentWallet.publicKey, "confirmed");
    return {
      cluster: this.config.cluster,
      quoteMint: this.config.oracleQuoteMint,
      quoteTokenLabel: this.config.quoteTokenLabel,
      configuredDefaults: {
        ownerWallet: this.config.defaultOwnerWallet,
        whirlpool: this.config.defaultWhirlpool,
      },
      agentWallet: this.agentWallet.publicKey.toBase58(),
      agentSolBalance: solBalance / 1_000_000_000,
      mandate,
      strategy,
      positions: livePositions,
      oracle,
      recentExecutions: this.db.getRecentExecutions(10),
      warnings: [
        ...(solBalance / 1_000_000_000 < this.config.minimumAgentSol
          ? [`Agent wallet needs at least ${this.config.minimumAgentSol} SOL for transaction fees and rent.`]
          : []),
        ...(!mandate ? ["No confirmed recurring allowance exists."] : []),
        ...(!strategy ? ["No active Orca strategy exists."] : []),
      ],
    };
  }

  async proposeMandate(input: {
    userWallet: string;
    mint: string;
    capTokens: string;
    periodSeconds?: number;
    expirySeconds?: number;
  }) {
    const current = this.db.getActiveMandate();
    if (current && (current.userWallet !== new PublicKey(input.userWallet).toBase58() || current.mint !== new PublicKey(input.mint).toBase58())) {
      throw new Error("This self-hosted installation already has an active mandate for another wallet or mint");
    }
    const request = await this.payments.prepareRequest({
      type: current ? "replace" : "create",
      userWallet: input.userWallet,
      mint: input.mint,
      capTokens: input.capTokens,
      periodSeconds: input.periodSeconds,
      expirySeconds: input.expirySeconds,
      currentMandate: current,
    });
    this.db.insertMandateRequest(request);
    return this.presentRequest(request);
  }

  async proposeRevocation() {
    const mandate = this.requireMandate();
    const request = await this.payments.prepareRequest({
      type: "revoke",
      userWallet: mandate.userWallet,
      mint: mandate.mint,
      currentMandate: mandate,
    });
    this.db.insertMandateRequest(request);
    return this.presentRequest(request);
  }

  getActionMetadata(id: string) {
    const request = this.requireRequest(id);
    const expired = Date.parse(request.expiresAt) <= Date.now();
    return {
      type: "action",
      icon: this.actionIconUrl(),
      title:
        request.type === "initialize"
          ? "Initialize Recurring Allowances"
          : request.type === "revoke"
            ? "Revoke LP Manager Allowance"
            : "Authorize LP Manager Allowance",
      description:
        request.type === "initialize"
          ? "Initialize your wallet's Solana Native Subscriptions authority. Your private key never leaves your wallet."
          : request.type === "revoke"
            ? "Revoke the recurring delegation used by your autonomous LP manager."
            : "Create a bounded recurring delegation to your local LP agent wallet.",
      label: request.type === "revoke" ? "Sign revoke" : "Review and sign",
      disabled: request.status !== "pending" || expired,
      error: expired ? { message: "This request expired. Ask the agent for a new link." } : undefined,
    };
  }

  presentActionCompletion(result: Awaited<ReturnType<LpManager["completeAction"]>>) {
    if (result.status === "authority_initialized" && "next" in result && result.next) {
      return {
        type: "action",
        icon: this.actionIconUrl(),
        title: "Create LP Allowance",
        description: "Wallet authority initialized. Sign the bounded recurring allowance to finish.",
        label: "Sign Allowance",
        links: {
          actions: [
            {
              type: "transaction",
              label: "Sign Allowance",
              href: result.next.actionUrl,
            },
          ],
        },
      };
    }
    return {
      type: "completed",
      icon: this.actionIconUrl(),
      title: result.status === "revoked" ? "Allowance Revoked" : "Allowance Active",
      description:
        result.status === "revoked"
          ? "The LP manager recurring allowance was revoked and verified on chain."
          : "The bounded recurring allowance was verified on chain and is ready for the LP manager.",
      label: result.status === "revoked" ? "Revoked" : "Authorized",
      disabled: true,
    };
  }

  async buildAction(id: string, account: string) {
    const request = this.requireRequest(id);
    return {
      ...(await this.payments.buildActionTransaction(request, account)),
      links: {
        next: {
          type: "post",
          href: `${request.actionUrl}/complete`,
        },
      },
    };
  }

  async completeAction(id: string, signature: string) {
    const request = this.requireRequest(id);
    if (request.status === "confirmed") {
      if (request.transactionSignature !== signature) {
        throw new Error("Mandate request was already completed with a different transaction");
      }
      if (request.type === "initialize") {
        const followUp = this.db.getFollowUpMandateRequest(request.id);
        if (!followUp) throw new Error("Initialized request is missing its allowance follow-up");
        return {
          status: "authority_initialized",
          message: "Initialization was already confirmed. Sign the allowance request.",
          next: this.presentRequest(followUp),
        };
      }
      if (request.type === "revoke") return { status: "revoked", signature };
      const mandate = request.expectedDelegationPda ? this.db.getMandate(request.expectedDelegationPda) : undefined;
      if (!mandate) throw new Error("Confirmed request is missing its reconciled mandate");
      return { status: "active", mandate, signature };
    }
    const result = await this.payments.verifyCompletedRequest(request, signature);
    if (result === "initialized") {
      this.db.completeMandateRequest({ requestId: id, signature });
      const decimals = (await getMint(this.connection, new PublicKey(request.mint), "confirmed")).decimals;
      const followUp = await this.payments.prepareRequest({
        type: request.currentDelegationPda ? "replace" : "create",
        userWallet: request.userWallet,
        mint: request.mint,
        capTokens: baseUnitsToTokenAmount(required(request.capBaseUnits), decimals),
        periodSeconds: request.periodSeconds,
        expirySeconds: required(request.expiryTs) - Math.floor(Date.now() / 1000),
        currentMandate: request.currentDelegationPda ? this.db.getMandate(request.currentDelegationPda) : undefined,
      });
      followUp.parentRequestId = request.id;
      this.db.insertMandateRequest(followUp);
      return {
        status: "authority_initialized",
        message: "Initialization confirmed. Sign the second request to create the bounded recurring allowance.",
        next: this.presentRequest(followUp),
      };
    }
    if (result === "revoked") {
      this.db.completeMandateRequest({ requestId: id, signature, revokedMandateId: request.currentDelegationPda });
      return { status: "revoked", signature };
    }
    this.db.completeMandateRequest({
      requestId: id,
      signature,
      mandate: result,
      revokedMandateId: request.type === "replace" ? request.currentDelegationPda : undefined,
    });
    return { status: "active", mandate: result, signature };
  }

  async configureStrategy(input: {
    whirlpool: string;
    rangeWidthBps?: number;
    rebalanceEdgeBps?: number;
    slippageBps?: number;
    deployFractionBps?: number;
    minimumScore?: number;
  }): Promise<Strategy> {
    const mandate = this.requireMandate();
    const pool = await this.orca.inspectPool(input.whirlpool);
    if (pool.liquidity === "0") throw new Error("Whirlpool has no active liquidity");
    if (mandate.mint !== pool.tokenMintA && mandate.mint !== pool.tokenMintB) {
      throw new Error("The recurring allowance mint must be one side of the selected Whirlpool");
    }
    if (mandate.mint !== this.config.oracleQuoteMint) {
      throw new Error(`The recurring allowance must use the configured quote mint ${this.config.oracleQuoteMint}`);
    }
    const wsol = NATIVE_MINT.toBase58();
    const poolMints = new Set([pool.tokenMintA, pool.tokenMintB]);
    if (!poolMints.has(wsol) || !poolMints.has(this.config.oracleQuoteMint)) {
      throw new Error(
        `The configured ${this.config.pythSymbol} feed only secures the ${wsol}/${this.config.oracleQuoteMint} Whirlpool pair`,
      );
    }
    const oracle = await fetchVerifiedPythPrice(this.config);
    const poolSolPrice = pool.tokenMintA === wsol ? Number(pool.currentPrice) : 1 / Number(pool.currentPrice);
    const deviationBps = Math.abs(poolSolPrice - Number(oracle.price)) / Number(oracle.price) * 10_000;
    if (deviationBps > this.config.maxPoolOracleDeviationBps) {
      throw new Error(
        `Whirlpool price ${poolSolPrice.toFixed(6)} differs from ${oracle.symbol} ${oracle.price} by ${deviationBps.toFixed(1)} bps`,
      );
    }
    const existing = this.db.getActiveStrategy();
    const now = new Date().toISOString();
    const strategy: Strategy = {
      id: existing?.id ?? randomUUID(),
      mandateId: mandate.id,
      whirlpool: pool.whirlpool,
      inputMint: mandate.mint,
      rangeWidthBps: boundedInteger(input.rangeWidthBps ?? 600, 50, 10_000, "rangeWidthBps"),
      rebalanceEdgeBps: boundedInteger(input.rebalanceEdgeBps ?? 75, 1, 5_000, "rebalanceEdgeBps"),
      slippageBps: boundedInteger(input.slippageBps ?? 100, 1, 1_000, "slippageBps"),
      deployFractionBps: boundedInteger(input.deployFractionBps ?? 5_000, 1, 10_000, "deployFractionBps"),
      minimumScore: boundedNumber(input.minimumScore ?? 70, 0, 100, "minimumScore"),
      status: "active",
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.db.upsertStrategy(strategy);
    return strategy;
  }

  async runCycle(trigger = "manual") {
    if (this.running) return { status: "skipped", reason: "another LP cycle is already running" };
    this.running = true;
    try {
      const mandate = await this.reconcileRequiredMandate();
      const strategy = this.requireStrategy();
      const oracle = await fetchVerifiedPythPrice(this.config);
      const pool = await this.orca.inspectPool(strategy.whirlpool);
      const poolMints = new Set([pool.tokenMintA, pool.tokenMintB]);
      if (!poolMints.has(NATIVE_MINT.toBase58()) || !poolMints.has(this.config.oracleQuoteMint)) {
        throw new Error("Whirlpool token mints no longer match the configured oracle pair");
      }
      const poolSolPrice = pool.tokenMintA === NATIVE_MINT.toBase58()
        ? Number(pool.currentPrice)
        : 1 / Number(pool.currentPrice);
      const deviationBps = Math.abs(poolSolPrice - Number(oracle.price)) / Number(oracle.price) * 10_000;
      if (deviationBps > this.config.maxPoolOracleDeviationBps) {
        return {
          status: "held",
          reason: `Whirlpool price deviates from ${oracle.symbol} by ${deviationBps.toFixed(1)} bps`,
          pool,
          oracle,
        };
      }
      const positions = await this.reconcilePositions(strategy);
      if (positions.length > 1) {
        throw new Error("Multiple live positions exist for one strategy; manual reconciliation is required");
      }
      if (positions.length === 1) {
        const position = positions[0];
        if (position.inRange && position.distanceToNearestEdgeBps > strategy.rebalanceEdgeBps) {
          return { status: "held", reason: "position is in range and outside the rebalance edge", position };
        }
        return await this.rebalance(strategy, mandate, position, trigger);
      }

      const recoverable = this.db.getRecoverableExecution(strategy.id);
      if (recoverable) {
        return await this.finishOpen(strategy, recoverable, BigInt(recoverable.amountBaseUnits));
      }

      const score = marketScore(oracle.confidenceBps, oracle.ageSeconds, this.config.maxOracleAgeSeconds);
      if (score < strategy.minimumScore) {
        return { status: "held", score, reason: `market score ${score.toFixed(1)} is below ${strategy.minimumScore}`, oracle };
      }
      const remaining = BigInt(mandate.capBaseUnits) - BigInt(mandate.amountPulledBaseUnits);
      if (remaining <= 0n) return { status: "held", score, reason: "recurring allowance is fully used for this period", oracle };
      const confidenceFactor = (score - strategy.minimumScore) / Math.max(1, 100 - strategy.minimumScore);
      const feedbackFactor = 1 + this.db.getFeedbackAdjustment(strategy.id);
      const fraction = Math.max(0.01, Math.min(1, (strategy.deployFractionBps / 10_000) * confidenceFactor * feedbackFactor));
      const amount = maxBigInt(1n, BigInt(new Decimal(remaining.toString()).mul(fraction).floor().toFixed(0)));
      const now = new Date().toISOString();
      const execution: ExecutionRecord = {
        id: randomUUID(),
        strategyId: strategy.id,
        mandateId: mandate.id,
        idempotencyKey: `${strategy.id}:${periodIndex(mandate.startTs, mandate.periodSeconds)}:initial-deploy`,
        trigger,
        action: "deploy",
        state: "planned",
        amountBaseUnits: amount.toString(),
        score,
        reason: `verified Pyth confidence ${oracle.confidenceBps.toFixed(2)} bps; deploy fraction ${(fraction * 100).toFixed(1)}%`,
        createdAt: now,
        updatedAt: now,
      };
      if (!this.db.insertExecution(execution)) {
        return { status: "skipped", reason: "this period's initial deployment already ran" };
      }
      try {
        const pull = await this.payments.pull(mandate, amount);
        this.db.updateExecution(execution.id, { state: "capital_pulled", pullSignature: pull.signature });
      } catch (error) {
        this.db.updateExecution(execution.id, { state: "failed", error: message(error) });
        throw error;
      }
      return await this.finishOpen(strategy, execution, amount);
    } finally {
      this.running = false;
    }
  }

  submitFeedback(input: { rating: number; choice: "increase" | "continue" | "reduce" | "stop"; notes?: string }) {
    const strategy = this.requireStrategy();
    if (!Number.isInteger(input.rating) || input.rating < 1 || input.rating > 5) {
      throw new Error("rating must be an integer from 1 to 5");
    }
    this.db.insertFeedback({ id: randomUUID(), strategyId: strategy.id, ...input, createdAt: new Date().toISOString() });
    return {
      recorded: true,
      boundedSizingAdjustment: this.db.getFeedbackAdjustment(strategy.id),
      requiresWalletSignature: input.choice === "increase" || input.choice === "reduce" || input.choice === "stop",
    };
  }

  private async finishOpen(strategy: Strategy, execution: ExecutionRecord, amount: bigint) {
    try {
      this.db.updateExecution(execution.id, { state: "position_opening" });
      const opened = await this.orca.openBalancedPosition({
        whirlpool: strategy.whirlpool,
        inputMint: strategy.inputMint,
        inputAmountBaseUnits: amount,
        rangeWidthBps: strategy.rangeWidthBps,
        slippageBps: strategy.slippageBps,
        balanceLimits:
          execution.tokenAAllocationBaseUnits && execution.tokenBAllocationBaseUnits
            ? {
                tokenABaseUnits: execution.tokenAAllocationBaseUnits,
                tokenBBaseUnits: execution.tokenBAllocationBaseUnits,
              }
            : undefined,
      });
      this.db.updateExecution(execution.id, {
        state: "active",
        swapSignature: opened.swapSignature,
        positionSignature: opened.openSignature,
      });
      const positions = await this.reconcilePositions(strategy, opened.openSignature);
      const position = positions.find((item) => item.positionMint === opened.positionMint);
      if (!position) throw new Error("Orca open transaction confirmed but the position account was not found");
      return { status: "deployed", executionId: execution.id, opened, position };
    } catch (error) {
      if (error instanceof OrcaPositionOpenError) {
        this.db.updateExecution(execution.id, {
          state: "swap_confirmed",
          swapSignature: error.recovery.swapSignature,
          tokenAAllocationBaseUnits: error.recovery.tokenAAllocationBaseUnits,
          tokenBAllocationBaseUnits: error.recovery.tokenBAllocationBaseUnits,
          error: error.message,
        });
      } else {
        this.db.updateExecution(execution.id, { state: "capital_pulled", error: message(error) });
      }
      throw error;
    }
  }

  private async rebalance(strategy: Strategy, mandate: Awaited<ReturnType<LpManager["reconcileRequiredMandate"]>>, position: LiveOrcaPosition, trigger: string) {
    const now = new Date().toISOString();
    const execution: ExecutionRecord = {
      id: randomUUID(), strategyId: strategy.id, mandateId: mandate.id,
      idempotencyKey: `${strategy.id}:${position.positionMint}:${position.currentTick}:rebalance`,
      trigger, action: "rebalance", state: "closing", amountBaseUnits: "0",
      reason: position.inRange ? `position is ${position.distanceToNearestEdgeBps.toFixed(1)} bps from its nearest edge` : "position is out of range",
      createdAt: now, updatedAt: now,
    };
    if (!this.db.insertExecution(execution)) return { status: "skipped", reason: "this rebalance event was already handled" };
    try {
      const closeSignatures = await this.orca.closePosition(position.positionAddress, strategy.slippageBps);
      this.db.upsertPosition({
        ...toPositionRecord(position, strategy.id, undefined),
        status: "closed",
        closeSignature: closeSignatures.at(-1),
        closedAt: new Date().toISOString(),
      });
      this.db.updateExecution(execution.id, { state: "position_opening", positionSignature: closeSignatures.at(-1) });
      const inputAmount = position.tokenMintA === strategy.inputMint ? BigInt(position.tokenAAmount) : BigInt(position.tokenBAmount);
      const pairedAmount = position.tokenMintA === strategy.inputMint ? BigInt(position.tokenBAmount) : BigInt(position.tokenAAmount);
      const rebalanceMint = inputAmount > 0n ? strategy.inputMint : position.tokenMintA === strategy.inputMint ? position.tokenMintB : position.tokenMintA;
      const rebalanceAmount = inputAmount > 0n ? inputAmount : maxBigInt(1n, pairedAmount);
      const opened = await this.orca.openBalancedPosition({
        whirlpool: strategy.whirlpool,
        inputMint: rebalanceMint,
        inputAmountBaseUnits: rebalanceAmount,
        rangeWidthBps: strategy.rangeWidthBps,
        slippageBps: strategy.slippageBps,
        balanceLimits: {
          tokenABaseUnits: (BigInt(position.tokenAAmount) + BigInt(position.feeOwedA)).toString(),
          tokenBBaseUnits: (BigInt(position.tokenBAmount) + BigInt(position.feeOwedB)).toString(),
        },
      });
      this.db.updateExecution(execution.id, { state: "active", swapSignature: opened.swapSignature, positionSignature: opened.openSignature });
      const live = await this.reconcilePositions(strategy, opened.openSignature);
      return { status: "rebalanced", closeSignatures, opened, position: live[0] };
    } catch (error) {
      this.db.updateExecution(execution.id, { state: "failed_recoverable", error: message(error) });
      throw error;
    }
  }

  private async reconcilePositions(strategy: Strategy, openSignature?: string): Promise<LiveOrcaPosition[]> {
    const live = await this.orca.inspectPositions(strategy.whirlpool);
    const existing = this.db.getActivePositions(strategy.id);
    const liveMints = new Set(live.map((position) => position.positionMint));
    for (const old of existing) {
      if (!liveMints.has(old.positionMint)) {
        this.db.upsertPosition({ ...old, status: "closed", updatedAt: new Date().toISOString(), closedAt: new Date().toISOString() });
      }
    }
    for (const position of live) {
      const previous = existing.find((item) => item.positionMint === position.positionMint);
      this.db.upsertPosition(toPositionRecord(position, strategy.id, previous?.openSignature ?? openSignature));
    }
    return live;
  }

  private async reconcileRequiredMandate() {
    const current = this.requireMandate();
    const reconciled = await this.payments.reconcileMandate(current);
    this.db.upsertMandate(reconciled);
    if (reconciled.status !== "active") throw new Error(`Recurring allowance is ${reconciled.status}`);
    return reconciled;
  }

  private requireMandate() {
    const mandate = this.db.getActiveMandate();
    if (!mandate) throw new Error("No confirmed active recurring allowance exists");
    return mandate;
  }

  private requireStrategy() {
    const strategy = this.db.getActiveStrategy();
    if (!strategy) throw new Error("No active Orca strategy exists");
    return strategy;
  }

  private requireRequest(id: string) {
    const request = this.db.getMandateRequest(id);
    if (!request) throw new Error(`Mandate request ${id} not found`);
    return request;
  }

  private presentRequest(request: MandateRequest) {
    const blinkUrl = `${this.config.publicBaseUrl}/plugins/lp-manager/sign/${request.id}`;
    return {
      id: request.id,
      type: request.type,
      expiresAt: request.expiresAt,
      actionUrl: request.actionUrl,
      blinkUrl,
      telegramButton: { text: request.type === "revoke" ? "Review & Revoke" : "Review & Sign", url: blinkUrl },
      agentWallet: request.agentWallet,
      userWallet: request.userWallet,
      capBaseUnits: request.capBaseUnits,
      periodSeconds: request.periodSeconds,
    };
  }

  private actionIconUrl(): string {
    return `${this.config.publicBaseUrl}/plugins/lp-manager/icon.svg`;
  }
}

function toPositionRecord(position: LiveOrcaPosition, strategyId: string, openSignature?: string): PositionRecord {
  const now = new Date().toISOString();
  return {
    positionMint: position.positionMint, positionAddress: position.positionAddress, strategyId,
    whirlpool: position.whirlpool, tickLower: position.tickLower, tickUpper: position.tickUpper,
    liquidity: position.liquidity, tokenAAmount: position.tokenAAmount, tokenBAmount: position.tokenBAmount,
    feeOwedA: position.feeOwedA, feeOwedB: position.feeOwedB, openSignature,
    status: "active", openedAt: now, updatedAt: now,
  };
}

function marketScore(confidenceBps: number, ageSeconds: number, maxAgeSeconds: number): number {
  const confidencePenalty = Math.min(60, confidenceBps * 2);
  const agePenalty = Math.min(30, (ageSeconds / maxAgeSeconds) * 30);
  return Math.max(0, Math.min(100, 100 - confidencePenalty - agePenalty));
}

function periodIndex(startTs: number, periodSeconds: number): number {
  return Math.max(0, Math.floor((Math.floor(Date.now() / 1000) - startTs) / periodSeconds));
}

function boundedInteger(value: number, min: number, max: number, name: string): number {
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer from ${min} to ${max}`);
  return value;
}

function boundedNumber(value: number, min: number, max: number, name: string): number {
  if (!Number.isFinite(value) || value < min || value > max) throw new Error(`${name} must be from ${min} to ${max}`);
  return value;
}

function maxBigInt(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Required mandate request value is missing");
  return value;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
