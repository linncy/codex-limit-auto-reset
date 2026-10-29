# codex-limit-auto-reset

A small tool that monitors Codex rate-limit reset credits, sends Chirpy expiry reminders, and automatically applies a reset **1 minute before each credit expires**.

## Scheduling and request frequency

- On startup, read the available credits and their expiry times.
- After a successful check, log the available credit count and the next check time in UTC. This confirms the account query succeeded and the local timer is waiting.
- Wait locally until `expiresAt - 60 seconds`. Do not redeem before that deadline.
- Rescan for new credits once every 6 hours, or sooner when a known credit reaches a reminder or redemption deadline. There are no account requests while the local timer waits.
- If started within the final 1 minute, attempt the reset immediately. Never send a redemption for an expired credit.
- If the server returns `nothingToReset` or `noCredit`, retry every 30 seconds only while the credit remains valid. Successful resets are followed by a fresh account-limit read.
- After network or process failures, reconnect with exponential backoff from 1 minute to 6 hours. Known pending deadlines shorten the wait; inside the final 1 minute, retry every 30 seconds.
- Persist each request's idempotency key before sending it. Ambiguous failures reuse the same key, including after a restart and when the credit is temporarily missing or reported as redeeming/redeemed; definitive non-redemptions start a new logical attempt. Completed credits are not retried against stale account data.

## Chirpy reminders and reset results

- Send expiry reminders at **48, 24, 12, 6, and 1 hour** before each available credit expires. Each message includes the credit ID, exact expiry time, time zone, and current remaining quota for each Codex window.
- Remaining quota is `100 - usedPercent`. A window with **80% or more remaining** is explicitly flagged with the reset restriction. Missing quota information is reported as unknown; it is never assumed to be zero. The server's redemption outcome remains authoritative.
- Every `reset` or `alreadyRedeemed` result gets a success notification. `alreadyRedeemed` is described as confirmation of a previous redemption.
- **`nothingToReset` is a reset failure**, not a successful reset. It is logged at error level, recorded in the durable notification history, and sent through Chirpy. `noCredit` and failed RPC requests are also recorded and notified. Network errors are described as unconfirmed outcomes and retain the original replay key. Each new logical redemption attempt has its own result notification.
- `Account check succeeded` means only that the account query/check completed; reset failures are logged separately as `reset FAILED`.
- Reminder deduplication and the notification outbox persist in SQLite beside the redemption state. After downtime, only the most recent overdue reminder is sent; future thresholds remain scheduled. Expired or superseded queued reminders are skipped. Result notifications remain queued even after credit expiry.
- Chirpy sending runs independently of redemption, with a 10-second request timeout and retry backoff of 5, 10, 20 seconds up to 5 minutes. Delivery requires HTTP 200 with `{"msg":"success"}`. A process crash after remote delivery but before the local acknowledgement can cause a repeat delivery.

The built-in Chirpy endpoint and token follow `~/agent-watchdog` and are bundled in `src/chirpy-defaults.ts`. Notifications use `POST /send_text` with `{token, text}` and an application User-Agent. Notification timestamps default to `America/Los_Angeles`.

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
  -e REDEEM_BEFORE_MINUTES=1 \
  codex-limit-auto-reset:local
```

Or run `docker compose up -d --build`. The Compose file builds this fork and mounts `$HOME/.codex`.

The container stores redemption state alongside the mounted Codex credentials so request keys survive container replacement. For local runs, keep `.reset-state.json` or set `STATE_FILE` to a persistent path. Run one monitor instance per account/state file.

### Troubleshooting Docker

Check both the container state and the last successful account query:

```sh
docker compose ps --all
docker compose logs --timestamps --tail 100
```

An exited container cannot redeem credits. With `restart: unless-stopped`, a container that was explicitly stopped stays stopped across Docker restarts. Start it again with `docker compose up -d`.

If logs report `failed to fetch codex rate limits: error sending request for url (https://chatgpt.com/backend-api/wham/usage)`, check network access and the system CA trust store. The runtime image installs `ca-certificates` because Codex needs OS certificates even when Node HTTPS requests succeed using Node's bundled certificates. Rebuild older images with `docker compose build`, then verify account access without redeeming anything:

```sh
docker compose run --rm --no-deps --entrypoint node codex-limit-auto-reset dist/cli.js
docker compose up -d
```

An `Account check succeeded` log confirms that account access works and shows when the next local check is due. A started container alone does not confirm a successful account query or redemption.

## Configuration

The following environment variables are available:

| Variable | Default | Description |
| --- | --- | --- |
| `REDEEM_BEFORE_MINUTES` | `1` | Minutes before expiration to start redeeming |
| `CODEX_BIN` | `codex` | Codex CLI command or path |
| `STATE_FILE` | `.reset-state.json` | Persistent request state; Docker uses `/data/codex/.limit-auto-reset-state.json` |
| `NOTIFICATION_STATE_FILE` | `${STATE_FILE}.notifications.sqlite` | Persistent reminder history and delivery queue; Docker persists it in the same credentials mount |
| `NOTIFICATION_TIMEZONE` | `America/Los_Angeles` | Time zone used in Chirpy messages |
| `CHIRPY_URL` | Bundled endpoint | Optional endpoint override, also used for local integration tests |
| `CHIRPY_TOKEN` | Bundled token | Optional token override |

Local runs also load variables from a `.env` file in the project root, which sets `REDEEM_BEFORE_MINUTES=1`. Explicit environment variables take precedence.

## Development

```sh
pnpm check
pnpm build
```

Tests simulate reminder/redemption deadlines, the 80% remaining threshold, durable deduplication and delivery retries, unsuccessful redemptions, ambiguous timeouts, restarts, expired credits, request frequency, and RPC failures. HTTP and process integration tests use local mock servers; they do not contact Codex or Chirpy services or consume real reset credits.

## License

[MIT](./LICENSE)
