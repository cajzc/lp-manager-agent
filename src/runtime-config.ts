import path from "node:path";
import { z } from "zod";

export const pluginConfigSchema = z.object({
  cluster: z.enum(["devnet", "mainnet-beta"]).default("devnet"),
  rpcUrl: z.string().url().optional(),
  publicBaseUrl: z.string().url(),
  databasePath: z.string().optional(),
  pythHermesUrl: z.string().url().default("https://hermes.pyth.network"),
  pythFeedId: z
    .string()
    .regex(/^0x[0-9a-fA-F]{64}$/)
    .default("0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d"),
  pythSymbol: z.string().min(1).default("SOL/USD"),
  oracleQuoteMint: z.string().optional(),
  quoteTokenLabel: z.string().min(1).max(40).default("USDC"),
  defaultOwnerWallet: z.string().min(32).optional(),
  defaultWhirlpool: z.string().min(32).optional(),
  maxOracleAgeSeconds: z.number().int().min(1).max(300).default(30),
  maxPoolOracleDeviationBps: z.number().int().min(1).max(5_000).default(500),
  monitorIntervalSeconds: z.number().int().min(5).max(3600).default(30),
  minimumAgentSol: z.number().positive().default(0.02),
  notificationSessionKey: z.string().min(1).default("agent:main:main"),
  notificationTelegramChatId: z.string().regex(/^-?[0-9]+$/).optional(),
  notificationsEnabled: z.boolean().default(true),
  enableMainnet: z.boolean().default(false),
});

export interface RuntimeConfig {
  cluster: "devnet" | "mainnet-beta";
  rpcUrl: string;
  publicBaseUrl: string;
  databasePath: string;
  agentKeypairPath: string;
  pythHermesUrl: string;
  pythFeedId: string;
  pythSymbol: string;
  oracleQuoteMint: string;
  quoteTokenLabel: string;
  defaultOwnerWallet?: string;
  defaultWhirlpool?: string;
  maxOracleAgeSeconds: number;
  maxPoolOracleDeviationBps: number;
  monitorIntervalSeconds: number;
  minimumAgentSol: number;
  notificationSessionKey: string;
  notificationTelegramChatId?: string;
  notificationsEnabled: boolean;
}

export function resolveRuntimeConfig(pluginConfig: unknown, stateDir: string): RuntimeConfig {
  const parsed = pluginConfigSchema.parse(pluginConfig ?? {});
  if (parsed.cluster === "mainnet-beta" && !parsed.enableMainnet) {
    throw new Error("Mainnet requires plugins.entries.lp-manager.config.enableMainnet=true");
  }

  const dataDir = path.join(stateDir, "lp-manager");
  return {
    cluster: parsed.cluster,
    rpcUrl:
      parsed.rpcUrl ??
      (parsed.cluster === "mainnet-beta"
        ? "https://api.mainnet-beta.solana.com"
        : "https://api.devnet.solana.com"),
    publicBaseUrl: parsed.publicBaseUrl.replace(/\/+$/, ""),
    databasePath: parsed.databasePath ?? path.join(dataDir, "lp-manager.sqlite"),
    agentKeypairPath: path.join(dataDir, "agent-keypair.json"),
    pythHermesUrl: parsed.pythHermesUrl.replace(/\/+$/, ""),
    pythFeedId: parsed.pythFeedId.toLowerCase(),
    pythSymbol: parsed.pythSymbol,
    oracleQuoteMint:
      parsed.oracleQuoteMint ??
      (parsed.cluster === "mainnet-beta"
        ? "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
        : "BRjpCHtyQLNCo8gqRUr8jtdAj5AjPYQaoqbvcZiHok1k"),
    quoteTokenLabel: parsed.quoteTokenLabel,
    defaultOwnerWallet: parsed.defaultOwnerWallet,
    defaultWhirlpool: parsed.defaultWhirlpool,
    maxOracleAgeSeconds: parsed.maxOracleAgeSeconds,
    maxPoolOracleDeviationBps: parsed.maxPoolOracleDeviationBps,
    monitorIntervalSeconds: parsed.monitorIntervalSeconds,
    minimumAgentSol: parsed.minimumAgentSol,
    notificationSessionKey: parsed.notificationSessionKey,
    notificationTelegramChatId: parsed.notificationTelegramChatId,
    notificationsEnabled: parsed.notificationsEnabled,
  };
}
