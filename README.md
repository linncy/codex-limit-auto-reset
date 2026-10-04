# codex-limit-auto-reset

A small tool that monitors Codex rate-limit reset credits and automatically applies a reset **3 minutes before each credit expires**.

## Scheduling and request frequency

- On startup, read the available credits and their expiry times.
- After a successful check, log the available credit count and the next check time in UTC. This confirms the account query succeeded and the local timer is waiting.
- Wait locally until `expiresAt - 180 seconds`. Do not redeem before that deadline.
- Rescan for new credits once every 6 hours, or sooner when a known credit reaches its deadline. There are no server requests while the local timer waits.
- If started within the final 3 minutes, attempt the reset immediately. Never send a redemption for an expired credit.
- If the server returns `nothingToReset` or `noCredit`, retry every 30 seconds only while the credit remains valid. Successful resets are followed by a fresh account-limit read.
- After network or process failures, reconnect with exponential backoff from 1 minute to 6 hours. Known pending deadlines shorten the wait; inside the final 3 minutes, retry every 30 seconds.
- Persist each request's idempotency key before sending it. Ambiguous failures reuse the same key, including after a restart and when the credit is temporarily missing or reported as redeeming/redeemed; definitive non-redemptions start a new logical attempt. Completed credits are not retried against stale account data.

The service must be running and the machine's clock must be correct. The deadline schedules the attempt; network latency and server eligibility determine when and whether the reset succeeds. The tool cannot force a reset when the server returns `nothingToReset`. Credits without expiry details are not automatically redeemed.

## Run locally

Requires Node.js 24 or later, pnpm, and an authenticated [Codex CLI](https://github.com/openai/codex).

```sh
pnpm install --frozen-lockfile
pnpm start
```

To list the available credits without redeeming them:

```sh
pnpm start:cli
```

## Run with Docker

Build this fork and mount your Codex CLI credentials into the container:

```sh
docker build -t codex-limit-auto-reset:local .
docker run -d \
  --name codex-limit-auto-reset \
  --restart unless-stopped \
  -v "$HOME/.codex:/data/codex" \
  -e REDEEM_BEFORE_MINUTES=3 \
  codex-limit-auto-reset:local
```

Or run `docker compose up -d --build`. The Compose file builds this fork and mounts `$HOME/.codex`.

The container stores redemption state alongside the mounted Codex credentials so request keys survive container replacement. For local runs, keep `.reset-state.json` or set `STATE_FILE` to a persistent path. Run one monitor instance per account/state file.

## Configuration

The following environment variables are available:

| Variable | Default | Description |
| --- | --- | --- |
| `REDEEM_BEFORE_MINUTES` | `3` | Minutes before expiration to start redeeming; keep `3` for the three-minute schedule |
| `CODEX_BIN` | `codex` | Codex CLI command or path |
| `STATE_FILE` | `.reset-state.json` | Persistent request state; Docker uses `/data/codex/.limit-auto-reset-state.json` |

Local runs also load variables from a `.env` file in the project root, which sets `REDEEM_BEFORE_MINUTES=3`. Explicit environment variables take precedence.

## Development

```sh
pnpm check
pnpm build
```

Tests simulate deadline boundaries, unsuccessful redemptions, ambiguous timeouts, restarts, expired credits, request frequency, and RPC failures. They do not contact Codex services or consume real reset credits.

## License

[MIT](./LICENSE)
