import BN from "bn.js";
import { Decimal } from "decimal.js";
import { Percentage } from "@orca-so/common-sdk";
import {
  buildWhirlpoolClient,
  collectFeesQuote,
  getAllPositionAccountsByOwner,
  increaseLiquidityQuoteByInputTokenUsingPriceDeviation,
  ORCA_WHIRLPOOL_PROGRAM_ID,
  PDAUtil,
  PoolUtil,
  PriceMath,
  swapQuoteByInputToken,
  TickUtil,
  TokenExtensionUtil,
  WhirlpoolContext,
} from "@orca-so/whirlpools-sdk";
import {
  getAccount,
  getAssociatedTokenAddressSync,
  NATIVE_MINT,
  TokenAccountNotFoundError,
  TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { z } from "zod";
import {
  KeypairWallet,
  SolanaAgentKit,
  type Action,
  type Plugin,
} from "solana-agent-kit";
import type { RuntimeConfig } from "./runtime-config.js";

export interface LiveOrcaPosition {
  positionAddress: string;
  positionMint: string;
  whirlpool: string;
  tokenMintA: string;
  tokenMintB: string;
  tokenDecimalsA: number;
  tokenDecimalsB: number;
  currentPrice: string;
  lowerPrice: string;
  upperPrice: string;
  currentTick: number;
  tickLower: number;
  tickUpper: number;
  liquidity: string;
  tokenAAmount: string;
  tokenBAmount: string;
  feeOwedA: string;
  feeOwedB: string;
  inRange: boolean;
  distanceToNearestEdgeBps: number;
}

export interface OpenBalancedPositionResult {
  swapSignature?: string;
  tickArraySignature?: string;
  openSignature: string;
  positionMint: string;
  positionAddress: string;
  tickLower: number;
  tickUpper: number;
}

export class OrcaPositionOpenError extends Error {
  constructor(
    message: string,
    readonly recovery: {
      swapSignature: string;
      tokenAAllocationBaseUnits: string;
      tokenBAllocationBaseUnits: string;
    },
  ) {
    super(message);
    this.name = "OrcaPositionOpenError";
  }
}

export interface OrcaPoolSnapshot {
  whirlpool: string;
  tokenMintA: string;
  tokenMintB: string;
  tokenDecimalsA: number;
  tokenDecimalsB: number;
  liquidity: string;
  currentTick: number;
  currentPrice: string;
}

export class OrcaAgentKitAdapter {
  readonly agent: SolanaAgentKit<any>;
  private readonly connection: Connection;

  constructor(
    private readonly config: RuntimeConfig,
    private readonly keypair: Keypair,
  ) {
    this.connection = new Connection(config.rpcUrl, "confirmed");
    const wallet = new KeypairWallet(keypair, config.rpcUrl);
    this.agent = new SolanaAgentKit(wallet, config.rpcUrl, {}).use(new OrcaLpPlugin(this));
  }

  async inspectPool(whirlpoolAddress: string): Promise<OrcaPoolSnapshot> {
    const pool = await buildWhirlpoolClient(this.context()).getPool(new PublicKey(whirlpoolAddress));
    const data = pool.getData();
    const tokenA = pool.getTokenAInfo();
    const tokenB = pool.getTokenBInfo();
    return {
      whirlpool: pool.getAddress().toBase58(),
      tokenMintA: tokenA.mint.toBase58(),
      tokenMintB: tokenB.mint.toBase58(),
      tokenDecimalsA: tokenA.decimals,
      tokenDecimalsB: tokenB.decimals,
      liquidity: data.liquidity.toString(),
      currentTick: data.tickCurrentIndex,
      currentPrice: PriceMath.sqrtPriceX64ToPrice(data.sqrtPrice, tokenA.decimals, tokenB.decimals)
        .toSignificantDigits(12)
        .toString(),
    };
  }

  async inspectPositions(whirlpoolFilter?: string): Promise<LiveOrcaPosition[]> {
    const ctx = this.context();
    const client = buildWhirlpoolClient(ctx);
    const owned = await getAllPositionAccountsByOwner({ ctx, owner: this.keypair.publicKey });
    const entries = [...owned.positions.entries(), ...owned.positionsWithTokenExtensions.entries()];
    const result: LiveOrcaPosition[] = [];

    for (const [positionAddress, positionData] of entries) {
      if (whirlpoolFilter && positionData.whirlpool.toBase58() !== whirlpoolFilter) continue;
      const whirlpool = await client.getPool(positionData.whirlpool);
      const pool = whirlpool.getData();
      const tokenA = whirlpool.getTokenAInfo();
      const tokenB = whirlpool.getTokenBInfo();
      const position = await client.getPosition(new PublicKey(positionAddress));
      const tokenExtensionCtx = await TokenExtensionUtil.buildTokenExtensionContextForPool(
        ctx.fetcher,
        tokenA.mint,
        tokenB.mint,
      );
      const amounts = PoolUtil.getTokenAmountsFromLiquidity(
        positionData.liquidity,
        pool.sqrtPrice,
        PriceMath.tickIndexToSqrtPriceX64(positionData.tickLowerIndex),
        PriceMath.tickIndexToSqrtPriceX64(positionData.tickUpperIndex),
        false,
      );
      const fees = collectFeesQuote({
        whirlpool: pool,
        position: positionData,
        tickLower: position.getLowerTickData(),
        tickUpper: position.getUpperTickData(),
        tokenExtensionCtx,
      });
      const currentPrice = PriceMath.sqrtPriceX64ToPrice(pool.sqrtPrice, tokenA.decimals, tokenB.decimals);
      const lowerPrice = PriceMath.tickIndexToPrice(positionData.tickLowerIndex, tokenA.decimals, tokenB.decimals);
      const upperPrice = PriceMath.tickIndexToPrice(positionData.tickUpperIndex, tokenA.decimals, tokenB.decimals);
      const lowerDistance = currentPrice.sub(lowerPrice).abs().div(currentPrice).mul(10_000).toNumber();
      const upperDistance = upperPrice.sub(currentPrice).abs().div(currentPrice).mul(10_000).toNumber();

      result.push({
        positionAddress,
        positionMint: positionData.positionMint.toBase58(),
        whirlpool: positionData.whirlpool.toBase58(),
        tokenMintA: tokenA.mint.toBase58(),
        tokenMintB: tokenB.mint.toBase58(),
        tokenDecimalsA: tokenA.decimals,
        tokenDecimalsB: tokenB.decimals,
        currentPrice: currentPrice.toSignificantDigits(12).toString(),
        lowerPrice: lowerPrice.toSignificantDigits(12).toString(),
        upperPrice: upperPrice.toSignificantDigits(12).toString(),
        currentTick: pool.tickCurrentIndex,
        tickLower: positionData.tickLowerIndex,
        tickUpper: positionData.tickUpperIndex,
        liquidity: positionData.liquidity.toString(),
        tokenAAmount: amounts.tokenA.toString(),
        tokenBAmount: amounts.tokenB.toString(),
        feeOwedA: fees.feeOwedA.toString(),
        feeOwedB: fees.feeOwedB.toString(),
        inRange:
          pool.tickCurrentIndex >= positionData.tickLowerIndex &&
          pool.tickCurrentIndex < positionData.tickUpperIndex,
        distanceToNearestEdgeBps: Math.max(0, Math.min(lowerDistance, upperDistance)),
      });
    }
    return result;
  }

  async openBalancedPosition(input: {
    whirlpool: string;
    inputMint: string;
    inputAmountBaseUnits: bigint;
    rangeWidthBps: number;
    slippageBps: number;
    balanceLimits?: { tokenABaseUnits: string; tokenBBaseUnits: string };
  }): Promise<OpenBalancedPositionResult> {
    if (input.inputAmountBaseUnits <= 0n) throw new Error("Input amount must be positive");
    const ctx = this.context();
    const client = buildWhirlpoolClient(ctx);
    const whirlpool = await client.getPool(new PublicKey(input.whirlpool));
    const pool = whirlpool.getData();
    const tokenA = whirlpool.getTokenAInfo();
    const tokenB = whirlpool.getTokenBInfo();
    const inputMint = new PublicKey(input.inputMint);
    if (!inputMint.equals(tokenA.mint) && !inputMint.equals(tokenB.mint)) {
      throw new Error(`Input mint ${input.inputMint} is not a token in Whirlpool ${input.whirlpool}`);
    }
    const otherMint = inputMint.equals(tokenA.mint) ? tokenB.mint : tokenA.mint;
    const slippage = Percentage.fromFraction(input.slippageBps, 10_000);
    const refreshed = await whirlpool.refreshData();
    const currentPrice = PriceMath.sqrtPriceX64ToPrice(refreshed.sqrtPrice, tokenA.decimals, tokenB.decimals);
    const halfWidth = input.rangeWidthBps / 20_000;
    const lowerPrice = currentPrice.mul(1 - halfWidth);
    const upperPrice = currentPrice.mul(1 + halfWidth);
    const tickLower = PriceMath.priceToInitializableTickIndex(
      lowerPrice,
      tokenA.decimals,
      tokenB.decimals,
      refreshed.tickSpacing,
    );
    const tickUpper = PriceMath.priceToInitializableTickIndex(
      upperPrice,
      tokenA.decimals,
      tokenB.decimals,
      refreshed.tickSpacing,
    );
    if (!TickUtil.checkTickInBounds(tickLower) || !TickUtil.checkTickInBounds(tickUpper) || tickLower >= tickUpper) {
      throw new Error("Calculated Orca range is invalid");
    }

    const tokenExtensionCtx = await TokenExtensionUtil.buildTokenExtensionContextForPool(
      ctx.fetcher,
      tokenA.mint,
      tokenB.mint,
    );
    const walletBalancesBefore = await Promise.all([
      this.walletTokenBalance(tokenA.mint, tokenA.tokenProgram, tokenA.decimals),
      this.walletTokenBalance(tokenB.mint, tokenB.tokenProgram, tokenB.decimals),
    ]);
    let balances = input.balanceLimits
      ? capBalances(walletBalancesBefore, input.balanceLimits, tokenA.decimals, tokenB.decimals)
      : scopedInputBalances(walletBalancesBefore, inputMint.equals(tokenA.mint), input.inputAmountBaseUnits);
    let liquidityQuote = bestLiquidityQuote(
      balances,
      tokenA.mint,
      tokenB.mint,
      tickLower,
      tickUpper,
      slippage,
      whirlpool,
      tokenExtensionCtx,
    );
    let swapSignature: string | undefined;
    if (!liquidityQuote || liquidityQuote.liquidityAmount.isZero()) {
      const availableInput = inputMint.equals(tokenA.mint) ? balances[0].baseUnits : balances[1].baseUnits;
      const requestedInput = new BN(input.inputAmountBaseUnits.toString());
      const swapAmount = BN.min(availableInput, requestedInput).divn(2);
      if (swapAmount.isZero()) {
        throw new Error(`No spendable ${inputMint.toBase58()} balance is available to balance the LP`);
      }
      const quote = await swapQuoteByInputToken(
        whirlpool,
        inputMint,
        swapAmount,
        slippage,
        ORCA_WHIRLPOOL_PROGRAM_ID,
        ctx.fetcher,
      );
      const estimatedEndPrice = PriceMath.sqrtPriceX64ToPrice(
        quote.estimatedEndSqrtPrice,
        tokenA.decimals,
        tokenB.decimals,
      );
      const priceImpactBps = estimatedEndPrice
        .sub(currentPrice)
        .abs()
        .div(currentPrice)
        .mul(10_000)
        .toNumber();
      if (priceImpactBps > this.config.maxPoolOracleDeviationBps) {
        throw new Error(
          `Balancing swap price impact ${priceImpactBps.toFixed(1)} bps exceeds ${this.config.maxPoolOracleDeviationBps} bps`,
        );
      }
      swapSignature = await (await whirlpool.swap(quote, this.keypair.publicKey)).buildAndExecute(
        undefined,
        undefined,
        "confirmed",
      );
      const walletBalancesAfter = await Promise.all([
        this.walletTokenBalance(tokenA.mint, tokenA.tokenProgram, tokenA.decimals),
        this.walletTokenBalance(tokenB.mint, tokenB.tokenProgram, tokenB.decimals),
      ]);
      balances = scopedPostSwapBalances({
            before: walletBalancesBefore,
            after: walletBalancesAfter,
            inputIsTokenA: inputMint.equals(tokenA.mint),
            allocatedBefore: balances,
            swapAmount,
            decimalsA: tokenA.decimals,
            decimalsB: tokenB.decimals,
          });
      liquidityQuote = bestLiquidityQuote(
        balances,
        tokenA.mint,
        tokenB.mint,
        tickLower,
        tickUpper,
        slippage,
        whirlpool,
        tokenExtensionCtx,
      );
    }
    if (!liquidityQuote || liquidityQuote.liquidityAmount.isZero()) {
      throw new Error(
        `Balanced wallet amounts are insufficient for the range; ${inputMint.toBase58()} and ${otherMint.toBase58()} balances could not satisfy the liquidity quote`,
      );
    }

    try {
      let tickArraySignature: string | undefined;
      const tickArrays = await whirlpool.initTickArrayForTicks([tickLower, tickUpper]);
      if (tickArrays) {
        tickArraySignature = await tickArrays.buildAndExecute(undefined, undefined, "confirmed");
      }
      const opened = await whirlpool.openPosition(
        tickLower,
        tickUpper,
        liquidityQuote,
        this.keypair.publicKey,
        this.keypair.publicKey,
        undefined,
        TOKEN_2022_PROGRAM_ID,
      );
      const openSignature = await opened.tx.buildAndExecute(undefined, undefined, "confirmed");
      const positionAddress = PDAUtil.getPosition(ORCA_WHIRLPOOL_PROGRAM_ID, opened.positionMint).publicKey;
      return {
        swapSignature,
        tickArraySignature,
        openSignature,
        positionMint: opened.positionMint.toBase58(),
        positionAddress: positionAddress.toBase58(),
        tickLower,
        tickUpper,
      };
    } catch (error) {
      if (swapSignature) {
        throw new OrcaPositionOpenError(
          error instanceof Error ? error.message : String(error),
          {
            swapSignature,
            tokenAAllocationBaseUnits: balances[0].baseUnits.toString(),
            tokenBAllocationBaseUnits: balances[1].baseUnits.toString(),
          },
        );
      }
      throw error;
    }
  }

  async closePosition(positionAddress: string, slippageBps: number): Promise<string[]> {
    const client = buildWhirlpoolClient(this.context());
    const position = await client.getPosition(new PublicKey(positionAddress));
    const whirlpool = await client.getPool(position.getData().whirlpool);
    const builders = await whirlpool.closePosition(
      new PublicKey(positionAddress),
      Percentage.fromFraction(slippageBps, 10_000),
      this.keypair.publicKey,
      this.keypair.publicKey,
      this.keypair.publicKey,
    );
    const signatures: string[] = [];
    for (const builder of builders) {
      signatures.push(await builder.buildAndExecute(undefined, undefined, "confirmed"));
    }
    return signatures;
  }

  private context(): WhirlpoolContext {
    return WhirlpoolContext.from(
      this.connection,
      {
        publicKey: this.agent.wallet.publicKey,
        signTransaction: this.agent.wallet.signTransaction.bind(this.agent.wallet),
        signAllTransactions: this.agent.wallet.signAllTransactions.bind(this.agent.wallet),
      },
      undefined,
      undefined,
      undefined,
      ORCA_WHIRLPOOL_PROGRAM_ID,
    );
  }

  private async walletTokenBalance(
    mint: PublicKey,
    tokenProgram: PublicKey,
    decimals: number,
  ): Promise<{ baseUnits: BN; natural: Decimal }> {
    let amount: bigint;
    if (mint.equals(NATIVE_MINT)) {
      const lamports = BigInt(await this.connection.getBalance(this.keypair.publicKey, "confirmed"));
      const reserve = BigInt(Math.ceil(this.config.minimumAgentSol * 1_000_000_000));
      amount = lamports > reserve ? lamports - reserve : 0n;
    } else {
      const ata = getAssociatedTokenAddressSync(mint, this.keypair.publicKey, false, tokenProgram);
      amount = 0n;
      try {
        amount = (await getAccount(this.connection, ata, "confirmed", tokenProgram)).amount;
      } catch (error) {
        if (!(error instanceof TokenAccountNotFoundError)) {
          throw error;
        }
      }
    }
    return {
      baseUnits: new BN(amount.toString()),
      natural: new Decimal(amount.toString()).div(new Decimal(10).pow(decimals)),
    };
  }
}

function scopedInputBalances(
  balances: Array<{ baseUnits: BN; natural: Decimal }>,
  inputIsTokenA: boolean,
  inputAmount: bigint,
): Array<{ baseUnits: BN; natural: Decimal }> {
  const index = inputIsTokenA ? 0 : 1;
  const scoped = [zeroBalance(), zeroBalance()];
  const amount = BN.min(balances[index].baseUnits, new BN(inputAmount.toString()));
  scoped[index] = withNaturalAmount(amount, balances[index]);
  return scoped;
}

function scopedPostSwapBalances(input: {
  before: Array<{ baseUnits: BN; natural: Decimal }>;
  after: Array<{ baseUnits: BN; natural: Decimal }>;
  inputIsTokenA: boolean;
  allocatedBefore: Array<{ baseUnits: BN; natural: Decimal }>;
  swapAmount: BN;
  decimalsA: number;
  decimalsB: number;
}): Array<{ baseUnits: BN; natural: Decimal }> {
  const inputIndex = input.inputIsTokenA ? 0 : 1;
  const outputIndex = input.inputIsTokenA ? 1 : 0;
  const result = [zeroBalance(), zeroBalance()];
  const remainingInput = input.allocatedBefore[inputIndex].baseUnits.sub(input.swapAmount);
  result[inputIndex] = amountWithDecimals(BN.min(input.after[inputIndex].baseUnits, remainingInput), inputIndex === 0 ? input.decimalsA : input.decimalsB);
  const outputDelta = input.after[outputIndex].baseUnits.sub(input.before[outputIndex].baseUnits);
  const allocatedOutput = input.allocatedBefore[outputIndex].baseUnits.add(BN.max(outputDelta, new BN(0)));
  result[outputIndex] = amountWithDecimals(BN.min(input.after[outputIndex].baseUnits, allocatedOutput), outputIndex === 0 ? input.decimalsA : input.decimalsB);
  return result;
}

function capBalances(
  balances: Array<{ baseUnits: BN; natural: Decimal }>,
  limits: { tokenABaseUnits: string; tokenBBaseUnits: string },
  decimalsA: number,
  decimalsB: number,
): Array<{ baseUnits: BN; natural: Decimal }> {
  return [
    amountWithDecimals(BN.min(balances[0].baseUnits, new BN(limits.tokenABaseUnits)), decimalsA),
    amountWithDecimals(BN.min(balances[1].baseUnits, new BN(limits.tokenBBaseUnits)), decimalsB),
  ];
}

function zeroBalance(): { baseUnits: BN; natural: Decimal } {
  return { baseUnits: new BN(0), natural: new Decimal(0) };
}

function withNaturalAmount(amount: BN, source: { baseUnits: BN; natural: Decimal }): { baseUnits: BN; natural: Decimal } {
  if (source.baseUnits.isZero()) return zeroBalance();
  return { baseUnits: amount, natural: source.natural.mul(amount.toString()).div(source.baseUnits.toString()) };
}

function amountWithDecimals(amount: BN, decimals: number): { baseUnits: BN; natural: Decimal } {
  return { baseUnits: amount, natural: new Decimal(amount.toString()).div(new Decimal(10).pow(decimals)) };
}

function bestLiquidityQuote(
  balances: Array<{ baseUnits: BN; natural: Decimal }>,
  tokenMintA: PublicKey,
  tokenMintB: PublicKey,
  tickLower: number,
  tickUpper: number,
  slippage: Percentage,
  whirlpool: Parameters<typeof increaseLiquidityQuoteByInputTokenUsingPriceDeviation>[5],
  tokenExtensionCtx: Parameters<typeof increaseLiquidityQuoteByInputTokenUsingPriceDeviation>[6],
) {
  const inputScale = new Decimal(1).div(new Decimal(1).add(slippage.toDecimal())).mul("0.999999");
  return [
    increaseLiquidityQuoteByInputTokenUsingPriceDeviation(
      tokenMintA,
      balances[0].natural.mul(inputScale),
      tickLower,
      tickUpper,
      slippage,
      whirlpool,
      tokenExtensionCtx,
    ),
    increaseLiquidityQuoteByInputTokenUsingPriceDeviation(
      tokenMintB,
      balances[1].natural.mul(inputScale),
      tickLower,
      tickUpper,
      slippage,
      whirlpool,
      tokenExtensionCtx,
    ),
  ]
    .filter(
      (quote) =>
        !quote.liquidityAmount.isZero() &&
        quote.tokenMaxA.lte(balances[0].baseUnits) &&
        quote.tokenMaxB.lte(balances[1].baseUnits),
    )
    .sort((a, b) => b.liquidityAmount.cmp(a.liquidityAmount))[0];
}

class OrcaLpPlugin implements Plugin {
  name = "orca-lp-manager";
  actions: Action[];
  methods: Record<string, (...args: any[]) => Promise<unknown>>;

  constructor(private readonly adapter: OrcaAgentKitAdapter) {
    this.methods = {
      inspectOrcaPool: async (_agent: SolanaAgentKit, whirlpool: string) =>
        await this.adapter.inspectPool(whirlpool),
      inspectOrcaPositions: async (_agent: SolanaAgentKit, whirlpool?: string) =>
        await this.adapter.inspectPositions(whirlpool),
      openBalancedOrcaPosition: async (_agent: SolanaAgentKit, input: Parameters<OrcaAgentKitAdapter["openBalancedPosition"]>[0]) =>
        await this.adapter.openBalancedPosition(input),
      closeOrcaPosition: async (_agent: SolanaAgentKit, positionAddress: string, slippageBps: number) =>
        await this.adapter.closePosition(positionAddress, slippageBps),
    };
    this.actions = [
      {
        name: "MANAGE_ORCA_LP_POSITION",
        similes: ["REBALANCE_LP", "OPEN_LP", "CLOSE_LP"],
        description: "Inspect and manage an Orca Whirlpool LP position within a verified recurring allowance.",
        examples: [],
        schema: z.object({ operation: z.enum(["inspect", "open", "close", "rebalance"]) }),
        handler: async () => ({
          status: "Use the policy-gated lp-manager OpenClaw tools; direct unrestricted execution is disabled.",
        }),
      },
    ];
  }

  initialize(): void {}
}
