import { Type } from "typebox";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { loadOrCreateAgentWallet } from "./agent-wallet.js";
import { LpManager } from "./lp-manager.js";
import { LpMonitor } from "./lp-monitor.js";
import { pluginConfigSchema, resolveRuntimeConfig } from "./runtime-config.js";

let manager: LpManager | undefined;
let monitor: LpMonitor | undefined;
const require = createRequire(import.meta.url);
const WEB3_BROWSER_BUNDLE = readFileSync(join(dirname(require.resolve("@solana/web3.js")), "index.iife.min.js"));

export default definePluginEntry({
  id: "lp-manager",
  name: "Solana LP Manager",
  description: "Autonomous Orca LP management bounded by Solana recurring allowances",
  configSchema: pluginConfigSchema,
  register(api) {
    registerTools(api);
    if (api.registrationMode !== "full") return;

    api.registerService({
      id: "lp-manager-runtime",
      start: async (ctx) => {
        const config = resolveRuntimeConfig(api.pluginConfig, ctx.stateDir);
        const wallet = loadOrCreateAgentWallet(config.agentKeypairPath);
        manager = new LpManager(config, wallet);
        monitor = new LpMonitor(
          manager,
          async (result) => {
            if (!config.notificationsEnabled) return;
            await api.runtime.subagent.run({
              sessionKey: config.notificationSessionKey,
              message:
                "The LP manager completed a material autonomous event. Use lp_manager_status to verify current on-chain state, then notify the user plainly with the actual range, balances, fees, score context, transaction signatures, and buttons for continue, change allowance, or stop. Event: " +
                JSON.stringify(result),
              deliver: true,
              idempotencyKey: `lp-manager:${JSON.stringify(result).slice(0, 128)}`,
            });
          },
          ctx.logger,
        );
        await monitor.start();
        ctx.logger.info(`LP manager started on ${config.cluster} with agent wallet ${wallet.publicKey.toBase58()}`);
      },
      stop: async () => {
        await monitor?.stop();
        manager?.close();
        monitor = undefined;
        manager = undefined;
      },
    });

    api.registerHttpRoute({
      path: "/actions.json",
      auth: "plugin",
      match: "exact",
      handler: async (_req, res) => {
        sendJson(res, 200, {
          rules: [
            {
              pathPattern: "/plugins/lp-manager/actions/mandates/**",
              apiPath: "/plugins/lp-manager/actions/mandates/**",
            },
          ],
        });
        return true;
      },
    });
    api.registerHttpRoute({
      path: "/plugins/lp-manager/icon.svg",
      auth: "plugin",
      match: "exact",
      handler: async (_req, res) => {
        setActionHeaders(res);
        res.statusCode = 200;
        res.setHeader("content-type", "image/svg+xml; charset=utf-8");
        res.setHeader("cache-control", "public, max-age=86400");
        res.end(ACTION_ICON);
        return true;
      },
    });
    api.registerHttpRoute({
      path: "/plugins/lp-manager/web3.js",
      auth: "plugin",
      match: "exact",
      handler: async (_req, res) => {
        res.statusCode = 200;
        res.setHeader("content-type", "application/javascript; charset=utf-8");
        res.setHeader("cache-control", "public, max-age=86400, immutable");
        res.end(WEB3_BROWSER_BUNDLE);
        return true;
      },
    });
    api.registerHttpRoute({
      path: "/plugins/lp-manager/sign",
      auth: "plugin",
      match: "prefix",
      handler: handleSigningPage,
    });
    api.registerHttpRoute({
      path: "/plugins/lp-manager/actions/mandates",
      auth: "plugin",
      match: "prefix",
      handler: async (req, res) => handleMandateAction(req, res, async (result) => {
        if (result.status === "authority_initialized") return;
        const service = requireManager();
        const chatId = service.config.notificationTelegramChatId;
        if (!service.config.notificationsEnabled || !chatId) return;
        if (result.status === "revoked") {
          await sendTelegram(chatId, "Thanks, the allowance is revoked and autonomous pool management has stopped.");
          return;
        }
        await sendTelegram(chatId, "Thanks, your allowance is confirmed on Solana. I’m opening the position now.");
        try {
          if (!service.db.getActiveStrategy()) {
            if (!service.config.defaultWhirlpool) throw new Error("No default Whirlpool is configured");
            await service.configureStrategy({ whirlpool: service.config.defaultWhirlpool });
          }
          const cycle = await service.runCycle("allowance_confirmed");
          await sendTelegram(chatId, formatActionContinuation(cycle));
        } catch (error) {
          await sendTelegram(chatId, `The allowance is active, but I couldn’t open the position: ${error instanceof Error ? error.message : String(error)}`);
        }
      }),
    });
    api.registerHttpRoute({
      path: "/plugins/lp-manager/health",
      auth: "gateway",
      match: "exact",
      handler: async (_req, res) => {
        sendJson(res, manager ? 200 : 503, { ok: Boolean(manager) });
        return true;
      },
    });
  },
});

async function handleSigningPage(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) {
  const url = new URL(req.url ?? "/", "http://localhost");
  const match = url.pathname.match(/^\/plugins\/lp-manager\/sign\/([0-9a-f-]+)$/i);
  if (req.method !== "GET" || !match) {
    res.statusCode = 404;
    res.end("Not found");
    return true;
  }
  res.statusCode = 200;
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.end(signingPage(match[1]));
  return true;
}

function registerTools(api: Parameters<Parameters<typeof definePluginEntry>[0]["register"]>[0]): void {
  api.registerTool({
    name: "lp_manager_status",
    label: "LP Manager Status",
    description: "Read verified recurring-allowance, Orca pool, live position range, token balances, fees, and execution history.",
    parameters: Type.Object({}, { additionalProperties: false }),
    execute: async () => toolResult(await requireManager().getStatus()),
  });
  api.registerTool({
    name: "lp_manager_authorize",
    label: "Authorize LP Manager",
    description: "Create a wallet-signable Blink for a user-selected recurring token allowance. The application never handles the user private key.",
    parameters: Type.Object(
      {
        userWallet: Type.Optional(Type.String({ minLength: 32 })),
        mint: Type.Optional(Type.String({ minLength: 32 })),
        capTokens: Type.String({ pattern: "^[0-9]+(?:\\.[0-9]+)?$" }),
        periodSeconds: Type.Optional(Type.Integer({ minimum: 60 })),
        expirySeconds: Type.Optional(Type.Integer({ minimum: 300 })),
      },
      { additionalProperties: false },
    ),
    execute: async (_id, input) => {
      const service = requireManager();
      const values = input as { userWallet?: string; mint?: string; capTokens: string; periodSeconds?: number; expirySeconds?: number };
      const userWallet = values.userWallet ?? service.config.defaultOwnerWallet;
      if (!userWallet) throw new Error("No owner wallet is configured; provide userWallet");
      return toolResult(await service.proposeMandate({
        ...values,
        userWallet,
        mint: values.mint ?? service.config.oracleQuoteMint,
      }));
    },
  });
  api.registerTool({
    name: "lp_manager_configure_strategy",
    label: "Configure LP Strategy",
    description: "Validate and configure the Orca Whirlpool and bounded strategy parameters for the confirmed allowance mint.",
    parameters: Type.Object(
      {
        whirlpool: Type.Optional(Type.String({ minLength: 32 })),
        rangeWidthBps: Type.Optional(Type.Integer({ minimum: 50, maximum: 10_000 })),
        rebalanceEdgeBps: Type.Optional(Type.Integer({ minimum: 1, maximum: 5_000 })),
        slippageBps: Type.Optional(Type.Integer({ minimum: 1, maximum: 1_000 })),
        deployFractionBps: Type.Optional(Type.Integer({ minimum: 1, maximum: 10_000 })),
        minimumScore: Type.Optional(Type.Number({ minimum: 0, maximum: 100 })),
      },
      { additionalProperties: false },
    ),
    execute: async (_id, input) => {
      const service = requireManager();
      const values = input as {
        whirlpool?: string;
        rangeWidthBps?: number;
        rebalanceEdgeBps?: number;
        slippageBps?: number;
        deployFractionBps?: number;
        minimumScore?: number;
      };
      const whirlpool = values.whirlpool ?? service.config.defaultWhirlpool;
      if (!whirlpool) throw new Error("No default Whirlpool is configured; provide whirlpool");
      return toolResult(await service.configureStrategy({ ...values, whirlpool }));
    },
  });
  api.registerTool({
    name: "lp_manager_run",
    label: "Run LP Manager",
    description: "Run one policy-gated cycle. It may hold, deploy, or rebalance, but cannot exceed the on-chain recurring allowance.",
    parameters: Type.Object({}, { additionalProperties: false }),
    execute: async () => toolResult(await requireManager().runCycle("openclaw_tool")),
  });
  api.registerTool({
    name: "lp_manager_feedback",
    label: "Rate LP Manager",
    description: "Store an owner rating and bounded risk preference used by future sizing decisions.",
    parameters: Type.Object(
      {
        rating: Type.Integer({ minimum: 1, maximum: 5 }),
        choice: Type.Union([
          Type.Literal("increase"),
          Type.Literal("continue"),
          Type.Literal("reduce"),
          Type.Literal("stop"),
        ]),
        notes: Type.Optional(Type.String({ maxLength: 2_000 })),
      },
      { additionalProperties: false },
    ),
    execute: async (_id, input) => toolResult(requireManager().submitFeedback(input as never)),
  });
  api.registerTool({
    name: "lp_manager_change_allowance",
    label: "Change LP Allowance",
    description: "Create a new user-signed Blink to replace the current recurring cap. The agent cannot sign this change.",
    parameters: Type.Object(
      { capTokens: Type.String({ pattern: "^[0-9]+(?:\\.[0-9]+)?$" }) },
      { additionalProperties: false },
    ),
    execute: async (_id, input) => {
      const service = requireManager();
      const current = service.db.getActiveMandate();
      if (!current) throw new Error("No active allowance exists");
      return toolResult(
        await service.proposeMandate({
          userWallet: current.userWallet,
          mint: current.mint,
          capTokens: (input as { capTokens: string }).capTokens,
          periodSeconds: current.periodSeconds,
          expirySeconds: Math.max(300, current.expiryTs - Math.floor(Date.now() / 1000)),
        }),
      );
    },
  });
  api.registerTool({
    name: "lp_manager_stop",
    label: "Stop LP Manager",
    description: "Create a user-signed Blink that revokes the recurring allowance. The agent cannot revoke user authority itself.",
    parameters: Type.Object({}, { additionalProperties: false }),
    execute: async () => toolResult(await requireManager().proposeRevocation()),
  });
}

async function handleMandateAction(
  req: import("node:http").IncomingMessage,
  res: import("node:http").ServerResponse,
  onComplete: (result: Awaited<ReturnType<LpManager["completeAction"]>>) => Promise<void>,
) {
  setActionHeaders(res);
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return true;
  }
  const url = new URL(req.url ?? "/", "http://localhost");
  const match = url.pathname.match(/^\/plugins\/lp-manager\/actions\/mandates\/([0-9a-f-]+)(\/complete)?$/i);
  if (!match) {
    sendJson(res, 404, { error: { message: "Action not found" } });
    return true;
  }
  try {
    const service = requireManager();
    const id = match[1];
    if (req.method === "GET" && !match[2]) {
      sendJson(res, 200, service.getActionMetadata(id));
      return true;
    }
    if (req.method === "POST") {
      const body = await readJson(req);
      if (match[2]) {
        const signature = String(body.signature ?? body.transactionSignature ?? "");
        if (!signature) throw new Error("A confirmed transaction signature is required");
        const result = await service.completeAction(id, signature);
        sendJson(res, 200, service.presentActionCompletion(result));
        void onComplete(result).catch((error) => {
          console.error("LP manager Action completed, but the agent continuation failed", error);
        });
      } else {
        const account = String(body.account ?? "");
        if (!account) throw new Error("Wallet account is required");
        sendJson(res, 200, await service.buildAction(id, account));
      }
      return true;
    }
    sendJson(res, 405, { error: { message: "Method not allowed" } });
  } catch (error) {
    sendJson(res, 400, { error: { message: error instanceof Error ? error.message : String(error) } });
  }
  return true;
}

function requireManager(): LpManager {
  if (!manager) throw new Error("LP manager service is not running; restart the OpenClaw Gateway after enabling the plugin");
  return manager;
}

function toolResult(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    details: value as Record<string, unknown>,
  };
}

function formatActionContinuation(result: unknown): string {
  const value = result as { status?: string; position?: { positionMint?: string; tickLower?: number; tickUpper?: number }; reason?: string };
  if (value.status === "deployed") {
    const range = value.position?.tickLower !== undefined && value.position.tickUpper !== undefined
      ? ` Range: ticks ${value.position.tickLower} to ${value.position.tickUpper}.`
      : "";
    return `Position opened successfully.${range}${value.position?.positionMint ? ` Position: ${value.position.positionMint}` : ""}`;
  }
  return `Allowance confirmed. The first management cycle returned ${value.status ?? "an unknown status"}${value.reason ? `: ${value.reason}` : "."}`;
}

async function sendTelegram(chatId: string, text: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN is unavailable to the gateway service");
  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
  if (!response.ok) throw new Error(`Telegram send failed with HTTP ${response.status}`);
}

async function readJson(req: import("node:http").IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > 64 * 1024) throw new Error("Request body is too large");
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

function sendJson(res: import("node:http").ServerResponse, status: number, value: unknown): void {
  setActionHeaders(res);
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(value));
}

function setActionHeaders(res: import("node:http").ServerResponse): void {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-methods", "GET,POST,PUT,OPTIONS");
  res.setHeader("access-control-allow-headers", "Content-Type,Authorization,Content-Encoding,Accept-Encoding");
  res.setHeader("x-action-version", "2.4");
  res.setHeader("x-blockchain-ids", "solana:mainnet,solana:devnet");
}

function signingPage(requestId: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>LP Manager Approval</title>
  <style>
    :root{color-scheme:dark;font-family:Inter,ui-sans-serif,system-ui,sans-serif;background:#090d12;color:#f3f5f7}
    *{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px}
    main{width:min(440px,100%);border:1px solid #29313b;border-radius:8px;padding:28px;background:#10161d}
    .mark{width:44px;height:44px;border-radius:8px;background:#17242a;color:#2dd4bf;display:grid;place-items:center;font-weight:800;font-size:20px}
    h1{font-size:22px;margin:20px 0 8px}p{color:#aeb8c4;line-height:1.5;margin:0 0 20px}
    button{width:100%;border:0;border-radius:7px;padding:13px 16px;background:#2dd4bf;color:#07110f;font:inherit;font-weight:750;cursor:pointer}
    button:disabled{opacity:.55;cursor:wait}.status{font-size:14px;margin-top:16px;min-height:21px}.error{color:#fb7185}.ok{color:#5eead4}
    small{display:block;color:#778493;margin-top:18px;line-height:1.45}
  </style>
</head>
<body><main>
  <div class="mark">LP</div><h1 id="title">Loading approval...</h1>
  <p id="description">Reading the on-chain allowance request.</p>
  <button id="approve" disabled>Connect Phantom</button>
  <div id="status" class="status"></div>
  <small>Your private key never leaves Phantom. This page can only request the transaction described above.</small>
</main>
<script src="/plugins/lp-manager/web3.js"></script>
<script>
const requestId=${JSON.stringify(requestId)};
const actionUrl='/plugins/lp-manager/actions/mandates/'+requestId;
const title=document.getElementById('title');
const description=document.getElementById('description');
const button=document.getElementById('approve');
const status=document.getElementById('status');
let nextAction=actionUrl;

function provider(){return window.phantom?.solana || (window.solana?.isPhantom ? window.solana : null)}
function showStatus(message,kind=''){status.textContent=message;status.className='status '+kind}
function applyMetadata(data){
  title.textContent=data.title || 'LP Manager Approval';
  description.textContent=data.description || '';
  button.textContent=data.label || 'Review and sign';
  button.disabled=Boolean(data.disabled);
  if(data.error) showStatus(data.error.message,'error');
}
async function json(response){
  const data=await response.json();
  if(!response.ok) throw new Error(data?.error?.message || data?.message || 'Request failed');
  return data;
}
async function finish(callback,signature,account){
  let lastError;
  for(let attempt=0;attempt<12;attempt++){
    try{return await json(await fetch(callback,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({signature,account})}))}
    catch(error){lastError=error;await new Promise(resolve=>setTimeout(resolve,1500))}
  }
  throw lastError;
}
async function execute(){
  button.disabled=true;
  try{
    const wallet=provider();
    if(!wallet) throw new Error('Open this page in a browser with Phantom installed.');
    showStatus('Connecting to Phantom...');
    const connected=await wallet.connect();
    const account=connected.publicKey.toString();
    showStatus('Building the verified transaction...');
    const payload=await json(await fetch(nextAction,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({account})}));
    if(!payload.transaction) throw new Error('The Action did not return a transaction.');
    const bytes=Uint8Array.from(atob(payload.transaction),character=>character.charCodeAt(0));
    const transaction=solanaWeb3.VersionedTransaction.deserialize(bytes);
    showStatus('Approve the transaction in Phantom.');
    const sent=await wallet.signAndSendTransaction(transaction);
    const signature=typeof sent==='string' ? sent : sent.signature;
    if(!signature) throw new Error('Phantom did not return a transaction signature.');
    showStatus('Verifying the allowance on chain...');
    const result=await finish(payload.links.next.href,signature,account);
    applyMetadata(result);
    if(result.type==='completed'){
      button.disabled=true;showStatus('Confirmed on Solana. You can return to Telegram.','ok');return;
    }
    const action=result.links?.actions?.[0];
    if(!action) throw new Error('The next approval step is missing.');
    nextAction=action.href;button.textContent=action.label || 'Continue';button.disabled=false;
    showStatus('First step confirmed. One final signature is required.','ok');
  }catch(error){showStatus(error instanceof Error ? error.message : String(error),'error');button.disabled=false}
}
button.addEventListener('click',execute);
(async()=>json(await fetch(actionUrl)))().then(data=>{applyMetadata(data);button.disabled=Boolean(data.disabled)}).catch(error=>{showStatus(error.message,'error')});
</script></body></html>`;
}

const ACTION_ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256"><rect width="256" height="256" rx="32" fill="#111827"/><path d="M58 82h40v20H78v72H58V82Zm54 0h46c28 0 44 14 44 39 0 26-17 41-46 41h-24v12h-20V82Zm20 20v40h23c18 0 27-7 27-20 0-14-8-20-26-20h-24Z" fill="#2dd4bf"/></svg>`;
