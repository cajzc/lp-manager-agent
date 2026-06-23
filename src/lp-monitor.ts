import { Connection, PublicKey } from "@solana/web3.js";
import type { LpManager } from "./lp-manager.js";
import { fetchVerifiedPythPrice } from "./pyth-oracle.js";

export class LpMonitor {
  private readonly connection: Connection;
  private pollTimer?: NodeJS.Timeout;
  private poolSubscription?: number;
  private subscribedPool?: string;
  private lastOraclePrice?: number;
  private debounceTimer?: NodeJS.Timeout;

  constructor(
    private readonly manager: LpManager,
    private readonly onMaterialEvent: (result: unknown) => Promise<void>,
    private readonly log: { info(message: string): void; warn(message: string): void },
  ) {
    this.connection = new Connection(manager.config.rpcUrl, "confirmed");
  }

  async start(): Promise<void> {
    await this.refreshPoolSubscription();
    await this.pollOracle();
    this.pollTimer = setInterval(() => void this.poll(), this.manager.config.monitorIntervalSeconds * 1000);
    this.pollTimer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    if (this.poolSubscription !== undefined) {
      await this.connection.removeAccountChangeListener(this.poolSubscription).catch(() => undefined);
    }
  }

  private async poll(): Promise<void> {
    try {
      await this.refreshPoolSubscription();
      await this.pollOracle();
    } catch (error) {
      this.log.warn(`LP monitor poll failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async refreshPoolSubscription(): Promise<void> {
    const pool = this.manager.db.getActiveStrategy()?.whirlpool;
    if (pool === this.subscribedPool) return;
    if (this.poolSubscription !== undefined) {
      await this.connection.removeAccountChangeListener(this.poolSubscription).catch(() => undefined);
      this.poolSubscription = undefined;
    }
    this.subscribedPool = pool;
    if (!pool) return;
    this.poolSubscription = this.connection.onAccountChange(
      new PublicKey(pool),
      () => this.scheduleMaterialCycle("orca_account_change"),
      "confirmed",
    );
    this.log.info(`Watching Orca Whirlpool ${pool} over Solana WebSocket`);
  }

  private async pollOracle(): Promise<void> {
    const strategy = this.manager.db.getActiveStrategy();
    if (!strategy) return;
    const snapshot = await fetchVerifiedPythPrice(this.manager.config);
    const price = Number(snapshot.price);
    if (this.lastOraclePrice !== undefined) {
      const moveBps = Math.abs((price - this.lastOraclePrice) / this.lastOraclePrice) * 10_000;
      if (moveBps >= strategy.rebalanceEdgeBps) {
        this.scheduleMaterialCycle("pyth_price_move");
      }
    }
    this.lastOraclePrice = price;
  }

  private scheduleMaterialCycle(trigger: string): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = undefined;
      void this.manager
        .runCycle(trigger)
        .then(async (result) => {
          const status = (result as { status?: string }).status;
          if (status === "deployed" || status === "rebalanced") {
            await this.onMaterialEvent(result);
          }
        })
        .catch((error) => this.log.warn(`Autonomous LP cycle failed: ${error instanceof Error ? error.message : String(error)}`));
    }, 3_000);
    this.debounceTimer.unref?.();
  }
}
