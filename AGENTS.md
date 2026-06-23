# LP Manager Plugin Notes

This repository is a native OpenClaw plugin. Normal user interactions must use the `lp_manager_*` OpenClaw tools through the running Gateway.

- Do not restore the legacy MCP server, sidecar worker, webhook process, copied skill, repo-local user key, or sample market snapshots.
- Never ask for or store a user seed phrase/private key.
- Do not claim an Orca position exists unless `lp_manager_status` returns a live on-chain position account.
- Do not bypass policy with a direct open-position tool.
- Authority creation, replacement, and revocation must remain user-signed Solana Actions and must be verified on chain before local state changes.
- Agent-signed operations must remain bounded by the confirmed recurring delegation and serialized/idempotent SQLite execution state.

Local development uses `npm test`, `npm run typecheck`, and `npm run build`. Runtime verification uses `npm run openclaw:inspect` and one `openclaw gateway run` process.
