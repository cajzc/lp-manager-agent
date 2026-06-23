import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

export type MandateRequestType = "initialize" | "create" | "replace" | "revoke";
type MandateRequestStatus = "pending" | "confirmed" | "expired" | "failed";

export interface MandateRequest {
  id: string;
  type: MandateRequestType;
  status: MandateRequestStatus;
  userWallet: string;
  agentWallet: string;
  mint: string;
  tokenProgram: string;
  userAta: string;
  agentAta: string;
  currentDelegationPda?: string;
  expectedDelegationPda?: string;
  capBaseUnits?: string;
  periodSeconds?: number;
  expiryTs?: number;
  nonce?: string;
  actionUrl: string;
  parentRequestId?: string;
  transactionSignature?: string;
  error?: string;
  createdAt: string;
  expiresAt: string;
  confirmedAt?: string;
}

export interface Mandate {
  id: string;
  userWallet: string;
  agentWallet: string;
  mint: string;
  tokenProgram: string;
  userAta: string;
  agentAta: string;
  capBaseUnits: string;
  amountPulledBaseUnits: string;
  periodSeconds: number;
  startTs: number;
  expiryTs: number;
  status: "active" | "revoked" | "expired";
  updatedAt: string;
}

export interface Strategy {
  id: string;
  mandateId: string;
  whirlpool: string;
  inputMint: string;
  rangeWidthBps: number;
  rebalanceEdgeBps: number;
  slippageBps: number;
  deployFractionBps: number;
  minimumScore: number;
  status: "active" | "paused" | "stopped";
  createdAt: string;
  updatedAt: string;
}

export interface PositionRecord {
  positionMint: string;
  positionAddress: string;
  strategyId: string;
  whirlpool: string;
  tickLower: number;
  tickUpper: number;
  liquidity: string;
  tokenAAmount: string;
  tokenBAmount: string;
  feeOwedA: string;
  feeOwedB: string;
  openSignature?: string;
  closeSignature?: string;
  status: "active" | "closed";
  openedAt: string;
  updatedAt: string;
  closedAt?: string;
}

export interface ExecutionRecord {
  id: string;
  strategyId: string;
  mandateId: string;
  idempotencyKey: string;
  trigger: string;
  action: "hold" | "deploy" | "rebalance" | "close" | "reconcile";
  state: string;
  amountBaseUnits: string;
  tokenAAllocationBaseUnits?: string;
  tokenBAllocationBaseUnits?: string;
  score?: number;
  reason: string;
  pullSignature?: string;
  swapSignature?: string;
  positionSignature?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export class ProductionDatabase {
  private readonly db: Database.Database;

  constructor(filename: string) {
    fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
    this.db = new Database(filename);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("busy_timeout = 5000");
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  insertMandateRequest(request: MandateRequest): void {
    this.db
      .prepare(`
        INSERT INTO mandate_requests (
          id, type, status, user_wallet, agent_wallet, mint, token_program, user_ata, agent_ata,
          current_delegation_pda, expected_delegation_pda, cap_base_units, period_seconds, expiry_ts,
          nonce, action_url, parent_request_id, transaction_signature, error, created_at, expires_at, confirmed_at
        ) VALUES (
          @id, @type, @status, @userWallet, @agentWallet, @mint, @tokenProgram, @userAta, @agentAta,
          @currentDelegationPda, @expectedDelegationPda, @capBaseUnits, @periodSeconds, @expiryTs,
          @nonce, @actionUrl, @parentRequestId, @transactionSignature, @error, @createdAt, @expiresAt, @confirmedAt
        )
      `)
      .run({
        currentDelegationPda: null,
        expectedDelegationPda: null,
        capBaseUnits: null,
        periodSeconds: null,
        expiryTs: null,
        nonce: null,
        transactionSignature: null,
        parentRequestId: null,
        error: null,
        confirmedAt: null,
        ...request,
      });
  }

  getMandateRequest(id: string): MandateRequest | undefined {
    return mapRequest(this.db.prepare("SELECT * FROM mandate_requests WHERE id = ?").get(id));
  }

  getFollowUpMandateRequest(parentRequestId: string): MandateRequest | undefined {
    return mapRequest(
      this.db.prepare("SELECT * FROM mandate_requests WHERE parent_request_id = ? ORDER BY created_at DESC LIMIT 1").get(parentRequestId),
    );
  }

  completeMandateRequest(input: {
    requestId: string;
    signature: string;
    mandate?: Mandate;
    revokedMandateId?: string;
  }): void {
    this.db.transaction(() => {
      const now = new Date().toISOString();
      this.db
        .prepare(
          `UPDATE mandate_requests
           SET status = 'confirmed', transaction_signature = ?, confirmed_at = ?, error = NULL
           WHERE id = ? AND status = 'pending'`,
        )
        .run(input.signature, now, input.requestId);
      if (input.revokedMandateId) {
        this.db.prepare("UPDATE mandates SET status = 'revoked', updated_at = ? WHERE id = ?").run(
          now,
          input.revokedMandateId,
        );
      }
      if (input.mandate) {
        this.upsertMandate(input.mandate);
      }
    })();
  }

  failMandateRequest(id: string, error: string): void {
    this.db
      .prepare("UPDATE mandate_requests SET status = 'failed', error = ? WHERE id = ? AND status = 'pending'")
      .run(error, id);
  }

  upsertMandate(mandate: Mandate): void {
    this.db
      .prepare(`
        INSERT INTO mandates (
          id, user_wallet, agent_wallet, mint, token_program, user_ata, agent_ata, cap_base_units,
          amount_pulled_base_units, period_seconds, start_ts, expiry_ts, status, updated_at
        ) VALUES (
          @id, @userWallet, @agentWallet, @mint, @tokenProgram, @userAta, @agentAta, @capBaseUnits,
          @amountPulledBaseUnits, @periodSeconds, @startTs, @expiryTs, @status, @updatedAt
        )
        ON CONFLICT(id) DO UPDATE SET
          cap_base_units = excluded.cap_base_units,
          amount_pulled_base_units = excluded.amount_pulled_base_units,
          start_ts = excluded.start_ts,
          expiry_ts = excluded.expiry_ts,
          status = excluded.status,
          updated_at = excluded.updated_at
      `)
      .run(mandate);
  }

  getActiveMandate(): Mandate | undefined {
    return mapMandate(
      this.db.prepare("SELECT * FROM mandates WHERE status = 'active' ORDER BY updated_at DESC LIMIT 1").get(),
    );
  }

  getMandate(id: string): Mandate | undefined {
    return mapMandate(this.db.prepare("SELECT * FROM mandates WHERE id = ?").get(id));
  }

  upsertStrategy(strategy: Strategy): void {
    this.db
      .prepare(`
        INSERT INTO strategies (
          id, mandate_id, whirlpool, input_mint, range_width_bps, rebalance_edge_bps, slippage_bps,
          deploy_fraction_bps, minimum_score, status, created_at, updated_at
        ) VALUES (
          @id, @mandateId, @whirlpool, @inputMint, @rangeWidthBps, @rebalanceEdgeBps, @slippageBps,
          @deployFractionBps, @minimumScore, @status, @createdAt, @updatedAt
        )
        ON CONFLICT(id) DO UPDATE SET
          range_width_bps = excluded.range_width_bps,
          rebalance_edge_bps = excluded.rebalance_edge_bps,
          slippage_bps = excluded.slippage_bps,
          deploy_fraction_bps = excluded.deploy_fraction_bps,
          minimum_score = excluded.minimum_score,
          status = excluded.status,
          updated_at = excluded.updated_at
      `)
      .run(strategy);
  }

  getActiveStrategy(): Strategy | undefined {
    return mapStrategy(
      this.db.prepare("SELECT * FROM strategies WHERE status = 'active' ORDER BY updated_at DESC LIMIT 1").get(),
    );
  }

  upsertPosition(position: PositionRecord): void {
    this.db
      .prepare(`
        INSERT INTO positions (
          position_mint, position_address, strategy_id, whirlpool, tick_lower, tick_upper, liquidity,
          token_a_amount, token_b_amount, fee_owed_a, fee_owed_b, open_signature, close_signature,
          status, opened_at, updated_at, closed_at
        ) VALUES (
          @positionMint, @positionAddress, @strategyId, @whirlpool, @tickLower, @tickUpper, @liquidity,
          @tokenAAmount, @tokenBAmount, @feeOwedA, @feeOwedB, @openSignature, @closeSignature,
          @status, @openedAt, @updatedAt, @closedAt
        )
        ON CONFLICT(position_mint) DO UPDATE SET
          liquidity = excluded.liquidity,
          token_a_amount = excluded.token_a_amount,
          token_b_amount = excluded.token_b_amount,
          fee_owed_a = excluded.fee_owed_a,
          fee_owed_b = excluded.fee_owed_b,
          close_signature = COALESCE(excluded.close_signature, positions.close_signature),
          status = excluded.status,
          updated_at = excluded.updated_at,
          closed_at = excluded.closed_at
      `)
      .run({ openSignature: null, closeSignature: null, closedAt: null, ...position });
  }

  getActivePositions(strategyId: string): PositionRecord[] {
    return this.db
      .prepare("SELECT * FROM positions WHERE strategy_id = ? AND status = 'active' ORDER BY opened_at")
      .all(strategyId)
      .map(mapPosition);
  }

  insertExecution(record: ExecutionRecord): boolean {
    return this.db
      .prepare(`
        INSERT OR IGNORE INTO executions (
          id, strategy_id, mandate_id, idempotency_key, trigger, action, state, amount_base_units,
          score, reason, token_a_allocation_base_units, token_b_allocation_base_units,
          pull_signature, swap_signature, position_signature, error, created_at, updated_at
        ) VALUES (
          @id, @strategyId, @mandateId, @idempotencyKey, @trigger, @action, @state, @amountBaseUnits,
          @score, @reason, @tokenAAllocationBaseUnits, @tokenBAllocationBaseUnits,
          @pullSignature, @swapSignature, @positionSignature, @error, @createdAt, @updatedAt
        )
      `)
      .run({
        score: null,
        tokenAAllocationBaseUnits: null,
        tokenBAllocationBaseUnits: null,
        pullSignature: null,
        swapSignature: null,
        positionSignature: null,
        error: null,
        ...record,
      }).changes === 1;
  }

  updateExecution(id: string, patch: Partial<Pick<ExecutionRecord,
    "state" | "tokenAAllocationBaseUnits" | "tokenBAllocationBaseUnits" |
    "pullSignature" | "swapSignature" | "positionSignature" | "error"
  >>): void {
    const current = this.db.prepare("SELECT * FROM executions WHERE id = ?").get(id) as Record<string, unknown>;
    if (!current) throw new Error(`Execution ${id} not found`);
    this.db
      .prepare(`
        UPDATE executions SET state = ?, token_a_allocation_base_units = ?, token_b_allocation_base_units = ?,
          pull_signature = ?, swap_signature = ?, position_signature = ?,
          error = ?, updated_at = ? WHERE id = ?
      `)
      .run(
        patch.state ?? current.state,
        patch.tokenAAllocationBaseUnits ?? current.token_a_allocation_base_units,
        patch.tokenBAllocationBaseUnits ?? current.token_b_allocation_base_units,
        patch.pullSignature ?? current.pull_signature,
        patch.swapSignature ?? current.swap_signature,
        patch.positionSignature ?? current.position_signature,
        patch.error ?? current.error,
        new Date().toISOString(),
        id,
      );
  }

  getRecentExecutions(limit = 10): ExecutionRecord[] {
    return this.db
      .prepare("SELECT * FROM executions ORDER BY created_at DESC LIMIT ?")
      .all(limit)
      .map(mapExecution);
  }

  getRecoverableExecution(strategyId: string): ExecutionRecord | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM executions
         WHERE strategy_id = ? AND state IN ('capital_pulled', 'swap_confirmed', 'position_opening')
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(strategyId);
    return row ? mapExecution(row) : undefined;
  }

  insertFeedback(input: { id: string; strategyId: string; rating: number; choice: string; notes?: string; createdAt: string }): void {
    this.db
      .prepare(
        "INSERT INTO feedback (id, strategy_id, rating, choice, notes, created_at) VALUES (@id, @strategyId, @rating, @choice, @notes, @createdAt)",
      )
      .run({ notes: null, ...input });
  }

  getFeedbackAdjustment(strategyId: string): number {
    const row = this.db
      .prepare("SELECT AVG(rating) AS average FROM feedback WHERE strategy_id = ?")
      .get(strategyId) as { average: number | null };
    return row.average == null ? 0 : Math.max(-0.2, Math.min(0.2, (row.average - 3) / 10));
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS mandate_requests (
        id TEXT PRIMARY KEY, type TEXT NOT NULL, status TEXT NOT NULL, user_wallet TEXT NOT NULL,
        agent_wallet TEXT NOT NULL, mint TEXT NOT NULL, token_program TEXT NOT NULL, user_ata TEXT NOT NULL,
        agent_ata TEXT NOT NULL, current_delegation_pda TEXT, expected_delegation_pda TEXT,
        cap_base_units TEXT, period_seconds INTEGER, expiry_ts INTEGER, nonce TEXT, action_url TEXT NOT NULL,
        parent_request_id TEXT, transaction_signature TEXT, error TEXT, created_at TEXT NOT NULL, expires_at TEXT NOT NULL,
        confirmed_at TEXT
      );
      CREATE TABLE IF NOT EXISTS mandates (
        id TEXT PRIMARY KEY, user_wallet TEXT NOT NULL, agent_wallet TEXT NOT NULL, mint TEXT NOT NULL,
        token_program TEXT NOT NULL, user_ata TEXT NOT NULL, agent_ata TEXT NOT NULL, cap_base_units TEXT NOT NULL,
        amount_pulled_base_units TEXT NOT NULL, period_seconds INTEGER NOT NULL, start_ts INTEGER NOT NULL,
        expiry_ts INTEGER NOT NULL, status TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS one_active_mandate ON mandates(status) WHERE status = 'active';
      CREATE TABLE IF NOT EXISTS strategies (
        id TEXT PRIMARY KEY, mandate_id TEXT NOT NULL REFERENCES mandates(id), whirlpool TEXT NOT NULL,
        input_mint TEXT NOT NULL, range_width_bps INTEGER NOT NULL, rebalance_edge_bps INTEGER NOT NULL,
        slippage_bps INTEGER NOT NULL, deploy_fraction_bps INTEGER NOT NULL, minimum_score REAL NOT NULL,
        status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS one_active_strategy ON strategies(status) WHERE status = 'active';
      CREATE TABLE IF NOT EXISTS positions (
        position_mint TEXT PRIMARY KEY, position_address TEXT NOT NULL, strategy_id TEXT NOT NULL REFERENCES strategies(id),
        whirlpool TEXT NOT NULL, tick_lower INTEGER NOT NULL, tick_upper INTEGER NOT NULL, liquidity TEXT NOT NULL,
        token_a_amount TEXT NOT NULL, token_b_amount TEXT NOT NULL, fee_owed_a TEXT NOT NULL, fee_owed_b TEXT NOT NULL,
        open_signature TEXT, close_signature TEXT, status TEXT NOT NULL, opened_at TEXT NOT NULL,
        updated_at TEXT NOT NULL, closed_at TEXT
      );
      CREATE TABLE IF NOT EXISTS executions (
        id TEXT PRIMARY KEY, strategy_id TEXT NOT NULL REFERENCES strategies(id), mandate_id TEXT NOT NULL REFERENCES mandates(id),
        idempotency_key TEXT NOT NULL UNIQUE, trigger TEXT NOT NULL, action TEXT NOT NULL, state TEXT NOT NULL,
        amount_base_units TEXT NOT NULL, score REAL, reason TEXT NOT NULL,
        token_a_allocation_base_units TEXT, token_b_allocation_base_units TEXT,
        pull_signature TEXT, swap_signature TEXT,
        position_signature TEXT, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS feedback (
        id TEXT PRIMARY KEY, strategy_id TEXT NOT NULL REFERENCES strategies(id), rating INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 5),
        choice TEXT NOT NULL, notes TEXT, created_at TEXT NOT NULL
      );
    `);
    this.ensureColumn("executions", "token_a_allocation_base_units", "TEXT");
    this.ensureColumn("executions", "token_b_allocation_base_units", "TEXT");
    this.ensureColumn("mandate_requests", "parent_request_id", "TEXT");
    this.db.exec("CREATE UNIQUE INDEX IF NOT EXISTS one_follow_up_request ON mandate_requests(parent_request_id) WHERE parent_request_id IS NOT NULL");
  }

  private ensureColumn(table: string, column: string, type: string): void {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!columns.some((item) => item.name === column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    }
  }
}

function mapRequest(value: unknown): MandateRequest | undefined {
  if (!value) return undefined;
  const row = value as Record<string, unknown>;
  return {
    id: String(row.id), type: row.type as MandateRequestType, status: row.status as MandateRequestStatus,
    userWallet: String(row.user_wallet), agentWallet: String(row.agent_wallet), mint: String(row.mint),
    tokenProgram: String(row.token_program), userAta: String(row.user_ata), agentAta: String(row.agent_ata),
    currentDelegationPda: optionalString(row.current_delegation_pda),
    expectedDelegationPda: optionalString(row.expected_delegation_pda), capBaseUnits: optionalString(row.cap_base_units),
    periodSeconds: optionalNumber(row.period_seconds), expiryTs: optionalNumber(row.expiry_ts), nonce: optionalString(row.nonce),
    actionUrl: String(row.action_url), transactionSignature: optionalString(row.transaction_signature),
    parentRequestId: optionalString(row.parent_request_id),
    error: optionalString(row.error), createdAt: String(row.created_at), expiresAt: String(row.expires_at),
    confirmedAt: optionalString(row.confirmed_at),
  };
}

function mapMandate(value: unknown): Mandate | undefined {
  if (!value) return undefined;
  const row = value as Record<string, unknown>;
  return {
    id: String(row.id), userWallet: String(row.user_wallet), agentWallet: String(row.agent_wallet),
    mint: String(row.mint), tokenProgram: String(row.token_program), userAta: String(row.user_ata),
    agentAta: String(row.agent_ata), capBaseUnits: String(row.cap_base_units),
    amountPulledBaseUnits: String(row.amount_pulled_base_units), periodSeconds: Number(row.period_seconds),
    startTs: Number(row.start_ts), expiryTs: Number(row.expiry_ts), status: row.status as Mandate["status"],
    updatedAt: String(row.updated_at),
  };
}

function mapStrategy(value: unknown): Strategy | undefined {
  if (!value) return undefined;
  const row = value as Record<string, unknown>;
  return {
    id: String(row.id), mandateId: String(row.mandate_id), whirlpool: String(row.whirlpool),
    inputMint: String(row.input_mint), rangeWidthBps: Number(row.range_width_bps),
    rebalanceEdgeBps: Number(row.rebalance_edge_bps), slippageBps: Number(row.slippage_bps),
    deployFractionBps: Number(row.deploy_fraction_bps), minimumScore: Number(row.minimum_score),
    status: row.status as Strategy["status"], createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  };
}

function mapPosition(value: unknown): PositionRecord {
  const row = value as Record<string, unknown>;
  return {
    positionMint: String(row.position_mint), positionAddress: String(row.position_address),
    strategyId: String(row.strategy_id), whirlpool: String(row.whirlpool), tickLower: Number(row.tick_lower),
    tickUpper: Number(row.tick_upper), liquidity: String(row.liquidity), tokenAAmount: String(row.token_a_amount),
    tokenBAmount: String(row.token_b_amount), feeOwedA: String(row.fee_owed_a), feeOwedB: String(row.fee_owed_b),
    openSignature: optionalString(row.open_signature), closeSignature: optionalString(row.close_signature),
    status: row.status as PositionRecord["status"], openedAt: String(row.opened_at), updatedAt: String(row.updated_at),
    closedAt: optionalString(row.closed_at),
  };
}

function mapExecution(value: unknown): ExecutionRecord {
  const row = value as Record<string, unknown>;
  return {
    id: String(row.id), strategyId: String(row.strategy_id), mandateId: String(row.mandate_id),
    idempotencyKey: String(row.idempotency_key), trigger: String(row.trigger), action: row.action as ExecutionRecord["action"],
    state: String(row.state), amountBaseUnits: String(row.amount_base_units), score: optionalNumber(row.score),
    tokenAAllocationBaseUnits: optionalString(row.token_a_allocation_base_units),
    tokenBAllocationBaseUnits: optionalString(row.token_b_allocation_base_units),
    reason: String(row.reason), pullSignature: optionalString(row.pull_signature), swapSignature: optionalString(row.swap_signature),
    positionSignature: optionalString(row.position_signature), error: optionalString(row.error),
    createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  };
}

function optionalString(value: unknown): string | undefined {
  return value == null ? undefined : String(value);
}

function optionalNumber(value: unknown): number | undefined {
  return value == null ? undefined : Number(value);
}
