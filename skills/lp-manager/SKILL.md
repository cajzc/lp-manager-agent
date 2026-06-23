---
name: lp-manager
description: Manage a user-owned Orca LP strategy through a bounded Solana recurring allowance.
---

# LP Manager

Use the `lp_manager_*` tools for every LP-manager operation. Never use shell commands, read SQLite, inspect key files, or call source modules to answer the user.

## Safety

- The user wallet is external. Never ask for a seed phrase or private key.
- `lp_manager_authorize`, `lp_manager_change_allowance`, and `lp_manager_stop` return wallet-signable Blink URLs. Present the URL as a Telegram button when inline buttons are available.
- Only `lp_manager_run` may deploy or rebalance. It enforces the recurring allowance and strategy policy.
- Never claim an Orca position exists unless `lp_manager_status.positions` contains its on-chain position account.
- Never invent APR, PnL, balances, ranges, or scores. Say `unknown` when live data does not support a metric.

## Conversation

- For status questions, call `lp_manager_status` and report the live range, current price, in-range state, token amounts, fees owed, allowance used/remaining, and recent confirmed signatures.
- To start, use the configured owner wallet, quote mint, and Whirlpool when available. Ask for addresses only when no defaults exist. Configure the strategy only after the signed allowance is confirmed.
- For reviews, offer: increase allowance, continue, reduce allowance, or stop. Record the rating with `lp_manager_feedback`; authority changes still require a Blink.
- After an autonomous notification, verify again with `lp_manager_status` before describing the result.
