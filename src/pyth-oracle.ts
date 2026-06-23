import { Decimal } from "decimal.js";
import type { RuntimeConfig } from "./runtime-config.js";

export interface OracleSnapshot {
  feedId: string;
  symbol: string;
  price: string;
  confidence: string;
  confidenceBps: number;
  publishTime: string;
  ageSeconds: number;
}

interface HermesResponse {
  parsed?: Array<{
    id: string;
    price?: { price: string; conf: string; expo: number; publish_time: number };
  }>;
}

export async function fetchVerifiedPythPrice(config: RuntimeConfig): Promise<OracleSnapshot> {
  const url = new URL(`${config.pythHermesUrl}/v2/updates/price/latest`);
  url.searchParams.append("ids[]", config.pythFeedId);
  url.searchParams.set("parsed", "true");
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`Pyth Hermes returned ${response.status}`);
  const body = (await response.json()) as HermesResponse;
  const parsed = body.parsed?.[0];
  if (!parsed?.price) throw new Error("Pyth response contained no parsed price");
  const responseFeed = `0x${parsed.id.replace(/^0x/, "")}`.toLowerCase();
  if (responseFeed !== config.pythFeedId) {
    throw new Error(`Pyth returned feed ${responseFeed}, expected ${config.pythFeedId}`);
  }
  const price = new Decimal(parsed.price.price).mul(new Decimal(10).pow(parsed.price.expo));
  const confidence = new Decimal(parsed.price.conf).mul(new Decimal(10).pow(parsed.price.expo));
  if (!price.isPositive()) throw new Error("Pyth price is not positive");
  const ageSeconds = Math.max(0, Math.floor(Date.now() / 1000) - parsed.price.publish_time);
  if (ageSeconds > config.maxOracleAgeSeconds) {
    throw new Error(`Pyth price is stale by ${ageSeconds}s (maximum ${config.maxOracleAgeSeconds}s)`);
  }
  return {
    feedId: responseFeed,
    symbol: config.pythSymbol,
    price: price.toSignificantDigits(16).toString(),
    confidence: confidence.toSignificantDigits(16).toString(),
    confidenceBps: confidence.div(price).mul(10_000).toNumber(),
    publishTime: new Date(parsed.price.publish_time * 1000).toISOString(),
    ageSeconds,
  };
}
