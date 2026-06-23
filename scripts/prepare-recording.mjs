#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { Decimal } from "decimal.js";
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  NATIVE_MINT,
} from "@solana/spl-token";
import {
  Connection,
  Keypair,
  PublicKey,
  sendAndConfirmTransaction,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import {
  buildWhirlpoolClient,
  ORCA_WHIRLPOOL_PROGRAM_ID,
  PDAUtil,
  PoolUtil,
  PriceMath,
  WhirlpoolContext,
} from "@orca-so/whirlpools-sdk";
import { KeypairWallet } from "solana-agent-kit";
import { OrcaAgentKitAdapter } from "../dist/orca-agentkit-plugin.js";
import { fetchVerifiedPythPrice } from "../dist/pyth-oracle.js";
import { resolveRuntimeConfig } from "../dist/runtime-config.js";

const DEVNET_WHIRLPOOLS_CONFIG = new PublicKey("FcrweFY1G9HJAHG5inkGB6pKg1HZ6x9UC2WioAfWrGkR");
const TICK_SPACING = 64;
const TEST_USD_DECIMALS = 6;
const USER_TEST_USD = 100n * 10n ** 6n;
const SEEDER_TEST_USD = 20n * 10n ** 6n;
const SEED_SOL_LAMPORTS = 50_000_000n;
const SEED_SOL_LIMIT_LAMPORTS = 60_000_000n;
const SEEDER_TARGET_LAMPORTS = 300_000_000;
const REQUIRED_AGENT_LAMPORTS = 550_000_000;

const checkOnly = process.argv.includes("--check");
const userWalletValue = argument("--user-wallet") ?? process.env.RECORDING_USER_WALLET;
if (!userWalletValue) {
  fail("Set RECORDING_USER_WALLET or pass --user-wallet <PUBLIC_KEY>.");
}

const userWallet = new PublicKey(userWalletValue);
const stateDir = process.env.OPENCLAW_STATE_DIR ?? path.join(os.homedir(), ".openclaw");
const openclawConfigPath = process.env.OPENCLAW_CONFIG_PATH ?? path.join(stateDir, "openclaw.json");
const openclawConfig = JSON.parse(fs.readFileSync(openclawConfigPath, "utf8"));
const pluginConfig = openclawConfig.plugins?.entries?.["lp-manager"]?.config;
const config = resolveRuntimeConfig(pluginConfig, stateDir);
if (config.cluster !== "devnet") fail("Recording preparation is restricted to Devnet.");

const connection = new Connection(config.rpcUrl, "confirmed");
const agent = readKeypair(config.agentKeypairPath);
const recordingDir = path.join(stateDir, "lp-manager", "recording");
const seederPath = path.join(recordingDir, "seeder-keypair.json");
const mintPath = path.join(recordingDir, "test-usd-mint-keypair.json");
const statePath = path.join(recordingDir, "setup.json");
const state = readJson(statePath) ?? {};

const agentBalance = await connection.getBalance(agent.publicKey, "confirmed");
const existingSetup = state.whirlpool ? await verifyExistingSetup() : undefined;
if (checkOnly) {
  console.log(JSON.stringify({
    ready: existingSetup?.valid ?? agentBalance >= REQUIRED_AGENT_LAMPORTS,
    agentWallet: agent.publicKey.toBase58(),
    agentSol: agentBalance / 1_000_000_000,
    requiredAgentSol: REQUIRED_AGENT_LAMPORTS / 1_000_000_000,
    additionalSolNeeded: existingSetup?.valid
      ? 0
      : Math.max(0, REQUIRED_AGENT_LAMPORTS - agentBalance) / 1_000_000_000,
    publicActionsUrl: `${config.publicBaseUrl}/actions.json`,
    existingSetup,
  }, null, 2));
  process.exit(0);
}
if (agentBalance < REQUIRED_AGENT_LAMPORTS) {
  fail(
    `Fund agent ${agent.publicKey.toBase58()} with at least ${((REQUIRED_AGENT_LAMPORTS - agentBalance) / 1_000_000_000).toFixed(4)} more Devnet SOL, then rerun this command.`,
  );
}

fs.mkdirSync(recordingDir, { recursive: true, mode: 0o700 });
const seeder = loadOrCreateKeypair(seederPath);
const mintKeypair = loadOrCreateKeypair(mintPath);
const oracle = await fetchVerifiedPythPrice(config);

if (!(await connection.getAccountInfo(mintKeypair.publicKey, "confirmed"))) {
  await createMint(
    connection,
    agent,
    agent.publicKey,
    null,
    TEST_USD_DECIMALS,
    mintKeypair,
    { commitment: "confirmed" },
  );
}

const userAta = await getOrCreateAssociatedTokenAccount(
  connection,
  agent,
  mintKeypair.publicKey,
  userWallet,
  false,
  "confirmed",
);
const seederAta = await getOrCreateAssociatedTokenAccount(
  connection,
  agent,
  mintKeypair.publicKey,
  seeder.publicKey,
  false,
  "confirmed",
);
await ensureTokenBalance(userAta.amount, USER_TEST_USD, userAta.address);
await ensureTokenBalance(seederAta.amount, SEEDER_TEST_USD, seederAta.address);
await ensureSeederSol();

const orderedMints = PoolUtil.orderMints(NATIVE_MINT, mintKeypair.publicKey).map((mint) => new PublicKey(mint));
const [tokenMintA, tokenMintB] = orderedMints;
const tokenADecimals = tokenMintA.equals(NATIVE_MINT) ? 9 : TEST_USD_DECIMALS;
const tokenBDecimals = tokenMintB.equals(NATIVE_MINT) ? 9 : TEST_USD_DECIMALS;
const oraclePrice = new Decimal(oracle.price);
const poolPrice = tokenMintA.equals(NATIVE_MINT) ? oraclePrice : new Decimal(1).div(oraclePrice);
const initialTick = PriceMath.priceToInitializableTickIndex(
  poolPrice,
  tokenADecimals,
  tokenBDecimals,
  TICK_SPACING,
);
const poolAddress = PDAUtil.getWhirlpool(
  ORCA_WHIRLPOOL_PROGRAM_ID,
  DEVNET_WHIRLPOOLS_CONFIG,
  tokenMintA,
  tokenMintB,
  TICK_SPACING,
).publicKey;

if (!(await connection.getAccountInfo(poolAddress, "confirmed"))) {
  const client = buildWhirlpoolClient(whirlpoolContext(connection, agent, config.rpcUrl));
  const created = await client.createPool(
    DEVNET_WHIRLPOOLS_CONFIG,
    tokenMintA,
    tokenMintB,
    TICK_SPACING,
    initialTick,
    agent.publicKey,
  );
  state.createPoolSignature = await created.tx.buildAndExecute(undefined, undefined, "confirmed");
}

const seederConfig = {
  ...config,
  oracleQuoteMint: mintKeypair.publicKey.toBase58(),
  minimumAgentSol: 0.05,
};
const seederOrca = new OrcaAgentKitAdapter(seederConfig, seeder);
const existingSeed = (await seederOrca.inspectPositions(poolAddress.toBase58()))[0];
if (existingSeed) {
  state.seedPositionMint = existingSeed.positionMint;
  state.seedPositionAddress = existingSeed.positionAddress;
} else {
  const quoteTokenBaseUnits = BigInt(
    oraclePrice.mul(new Decimal(SEED_SOL_LAMPORTS.toString()).div(1_000_000_000)).mul(1_000_000).ceil().toFixed(0),
  );
  const quoteTokenLimit = quoteTokenBaseUnits * 2n;
  const tokenABaseUnits = tokenMintA.equals(NATIVE_MINT) ? SEED_SOL_LIMIT_LAMPORTS : quoteTokenLimit;
  const tokenBBaseUnits = tokenMintB.equals(NATIVE_MINT) ? SEED_SOL_LIMIT_LAMPORTS : quoteTokenLimit;
  const opened = await seederOrca.openBalancedPosition({
    whirlpool: poolAddress.toBase58(),
    inputMint: mintKeypair.publicKey.toBase58(),
    inputAmountBaseUnits: quoteTokenBaseUnits,
    rangeWidthBps: 5_000,
    slippageBps: 100,
    balanceLimits: {
      tokenABaseUnits: tokenABaseUnits.toString(),
      tokenBBaseUnits: tokenBBaseUnits.toString(),
    },
  });
  state.seedPositionMint = opened.positionMint;
  state.seedPositionAddress = opened.positionAddress;
  state.seedSignature = opened.openSignature;
}

Object.assign(state, {
  version: 1,
  cluster: "devnet",
  label: "Agent Test USD",
  userWallet: userWallet.toBase58(),
  agentWallet: agent.publicKey.toBase58(),
  seederWallet: seeder.publicKey.toBase58(),
  quoteMint: mintKeypair.publicKey.toBase58(),
  userTokenAccount: userAta.address.toBase58(),
  whirlpool: poolAddress.toBase58(),
  oraclePrice: oracle.price,
  preparedAt: new Date().toISOString(),
});
writeJson(statePath, state, 0o600);

patchOpenClawQuoteMint(state.quoteMint);
console.log(JSON.stringify({
  ready: true,
  ...state,
  telegramMessages: [
    "Start managing the pool with up to 1 Agent Test USD a week.",
    "I signed it. Go ahead and open the position.",
    "Hey, how's the pool doing?",
    "Let's increase it to 2 Agent Test USD a week.",
    "Close everything and stop managing it.",
  ],
  next: [
    "Restart the OpenClaw Gateway so it loads the recording quote mint.",
    `In Telegram, authorize 1 Agent Test USD per week from ${state.userWallet}.`,
    `Configure Whirlpool ${state.whirlpool} and run the LP manager.`,
  ],
}, null, 2));

async function verifyExistingSetup() {
  try {
    const [mintAccount, poolAccount, positionAccount, oracleSnapshot] = await Promise.all([
      connection.getAccountInfo(new PublicKey(state.quoteMint), "confirmed"),
      connection.getAccountInfo(new PublicKey(state.whirlpool), "confirmed"),
      connection.getAccountInfo(new PublicKey(state.seedPositionAddress), "confirmed"),
      fetchVerifiedPythPrice(config),
    ]);
    const pool = await new OrcaAgentKitAdapter(
      { ...config, oracleQuoteMint: state.quoteMint },
      agent,
    ).inspectPool(state.whirlpool);
    const poolSolPrice = pool.tokenMintA === NATIVE_MINT.toBase58()
      ? Number(pool.currentPrice)
      : 1 / Number(pool.currentPrice);
    const deviationBps = Math.abs(poolSolPrice - Number(oracleSnapshot.price)) / Number(oracleSnapshot.price) * 10_000;
    const userBalance = await connection.getTokenAccountBalance(new PublicKey(state.userTokenAccount), "confirmed");
    return {
      valid:
        Boolean(mintAccount) &&
        poolAccount?.owner.equals(ORCA_WHIRLPOOL_PROGRAM_ID) === true &&
        positionAccount?.owner.equals(ORCA_WHIRLPOOL_PROGRAM_ID) === true &&
        BigInt(userBalance.value.amount) > 0n &&
        deviationBps <= config.maxPoolOracleDeviationBps,
      state,
      poolPrice: poolSolPrice,
      oraclePrice: Number(oracleSnapshot.price),
      deviationBps,
      userTestUsd: userBalance.value.uiAmountString,
    };
  } catch (error) {
    return { valid: false, state, error: error instanceof Error ? error.message : String(error) };
  }
}

async function ensureTokenBalance(current, target, destination) {
  if (current >= target) return;
  await mintTo(
    connection,
    agent,
    mintKeypair.publicKey,
    destination,
    agent,
    target - current,
    [],
    { commitment: "confirmed" },
  );
}

async function ensureSeederSol() {
  const balance = await connection.getBalance(seeder.publicKey, "confirmed");
  if (balance >= SEEDER_TARGET_LAMPORTS) return;
  const transaction = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: agent.publicKey,
      toPubkey: seeder.publicKey,
      lamports: SEEDER_TARGET_LAMPORTS - balance,
    }),
  );
  await sendAndConfirmTransaction(connection, transaction, [agent], { commitment: "confirmed" });
}

function patchOpenClawQuoteMint(quoteMint) {
  const patch = {
    plugins: { entries: { "lp-manager": { config: {
      oracleQuoteMint: quoteMint,
      quoteTokenLabel: "Agent Test USD",
      defaultOwnerWallet: userWallet.toBase58(),
      defaultWhirlpool: poolAddress.toBase58(),
    } } } },
  };
  const result = spawnSync("npx", ["openclaw", "config", "patch", "--stdin"], {
    input: JSON.stringify(patch),
    encoding: "utf8",
    stdio: ["pipe", "inherit", "inherit"],
  });
  if (result.status !== 0) fail("Pool was prepared, but OpenClaw config could not be updated.");
}

function whirlpoolContext(rpc, keypair, rpcUrl) {
  const wallet = new KeypairWallet(keypair, rpcUrl);
  return WhirlpoolContext.from(
    rpc,
    {
      publicKey: wallet.publicKey,
      signTransaction: wallet.signTransaction.bind(wallet),
      signAllTransactions: wallet.signAllTransactions.bind(wallet),
    },
    undefined,
    undefined,
    undefined,
    ORCA_WHIRLPOOL_PROGRAM_ID,
  );
}

function loadOrCreateKeypair(filename) {
  if (fs.existsSync(filename)) return readKeypair(filename);
  const keypair = Keypair.generate();
  writeJson(filename, Array.from(keypair.secretKey), 0o600);
  return keypair;
}

function readKeypair(filename) {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(filename, "utf8"))));
}

function readJson(filename) {
  return fs.existsSync(filename) ? JSON.parse(fs.readFileSync(filename, "utf8")) : undefined;
}

function writeJson(filename, value, mode) {
  fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temporary = `${filename}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode, flag: "wx" });
  fs.renameSync(temporary, filename);
  fs.chmodSync(filename, mode);
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
