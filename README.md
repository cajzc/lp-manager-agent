# Solana LP Manager for OpenClaw

Use Solana recurring allowances and an OpenClaw skill to manage Orca Whirlpool LP positions from Telegram.

The agent reads SOL/USD prices from Pyth, checks live pool and position data on Solana, and stores its strategy, allowance, position, and execution state in a local SQLite database. Solana Blinks let the user sign wallet actions to create, increase, replace, or revoke the agent's recurring allowance. The agent can only deploy and rebalance funds within that confirmed limit.


https://github.com/user-attachments/assets/3269fe21-297c-41a9-ab9e-4cc2a202436b


## How It Works

1. Tell the OpenClaw Telegram bot which Orca pool to manage and set a weekly spending limit.
2. The bot returns a Blink for the required wallet signature.
3. The plugin verifies the recurring allowance on-chain.
4. The agent uses Pyth and Orca data to open, monitor, and rebalance the position.
5. Position and execution state are persisted locally in `~/.openclaw/lp-manager/lp-manager.sqlite`.

The user's private key never enters this application. The user's wallet signs authority changes; a local agent wallet signs bounded LP operations.

## Setup

Requirements:

- Node.js 22+
- OpenClaw with Telegram configured
- A public HTTPS URL forwarding to the OpenClaw Gateway
- A Solana wallet and funded agent wallet

```bash
git clone https://github.com/cajzc/lp-manager-agent.git
cd lp-manager-agent
npm ci
PUBLIC_BASE_URL=https://your-host.example npm run openclaw:install
openclaw gateway run
```

For a local Gateway exposed through Tailscale:

```bash
sudo tailscale serve --bg http://127.0.0.1:18789
```

## Run It

Send the Telegram bot a prompt such as:

```text
Manage an Orca SOL/USDC position with up to 5 USDC per week.
My public wallet is <wallet>, and the Whirlpool is <address>.
```

Open the returned Blink, review the allowance, and sign it with your wallet. The bot will verify the transaction before deploying funds.

## Verify

```bash
npm test
npm run typecheck
npm run build
npm run openclaw:inspect
```

The plugin defaults to Solana Devnet. Mainnet requires `enableMainnet: true`, a production RPC provider, and an independent security review.
