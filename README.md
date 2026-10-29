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

## 一键安装／卸载（Linux 服务器）

安装脚本使用**已有的本机 Docker**。缺少 Docker、daemon 未启动或当前用户没有 Docker 权限时，只提示并退出，**不会安装、升级、启动 Docker，也不会修改用户组或安装系统软件包**。需要 Bash、Python 3.9+；在线安装还需要 `curl` 和 `tar`。宿主机不需要 Node.js、pnpm、Codex CLI 或 Docker Compose。

```sh
curl -fsSL https://raw.githubusercontent.com/linncy/codex-limit-auto-reset/main/install.sh | bash
```

已克隆仓库时也可以直接执行 `bash install.sh`。脚本默认构建当前源码镜像，内置 Chirpy 配置和 Node.js / Codex CLI；容器使用 `unless-stopped` 重启策略。需要 Docker 自身在服务器重启后启动，容器才会自动恢复。

默认复用当前用户的 `~/.codex/auth.json`。没有凭据时，脚本会启动设备码登录并显示浏览器链接，完成一次 ChatGPT 登录后自动继续。服务需要 ChatGPT 登录，API key 登录不能查询此类重置券。凭据若仅在系统钥匙串中，需要使用文件登录或复制 `auth.json`；设备码登录的账号设置及复制凭据方法见 [Codex 官方登录说明](https://learn.chatgpt.com/docs/auth)。

自定义路径、时区或兑换窗口：

```sh
bash install.sh \
  --install-dir "$HOME/.local/share/codex-limit-auto-reset" \
  --codex-home "$HOME/.codex" \
  --timezone Asia/Shanghai \
  --redeem-before-minutes 1
```

| 参数 | 含义 |
| --- | --- |
| `--install-dir DIR` | 默认 `${XDG_DATA_HOME:-$HOME/.local/share}/codex-limit-auto-reset`；自定义目录在升级／卸载时保持一致 |
| `--codex-home DIR` | 凭据目录，默认 `~/.codex`；容器以执行脚本用户的 UID/GID 读写，自动刷新的凭据保存在此处 |
| `--name NAME` | 容器名，默认 `codex-limit-auto-reset` |
| `--timezone ZONE` | Chirpy 提醒时区，默认 `America/Los_Angeles` |
| `--redeem-before-minutes N` | 到期前 N 分钟开始兑换，默认 1 |
| `--image IMAGE` | 使用已有镜像；本地不存在则拉取。省略时构建源码，可用于指定版本或离线部署 |
| `--no-login` | 无 `auth.json` 时退出，适合预先复制凭据后的无人值守安装 |
| `--health-timeout N` | 启动后等待账户检查成功的秒数，默认 45 |

安装前先验证配置、状态目录写入权限和真实账户查询，确认可用后才启动监控。升级时旧容器保留至新容器通过账户检查；新版本启动失败会恢复旧容器。重复运行安装命令即可升级；未重新指定的时区和兑换窗口会沿用旧设置。在线安装可以通过 `CODEX_RESET_REF` 指定 Git 分支、tag 或提交，例如：

```sh
curl -fsSL https://raw.githubusercontent.com/linncy/codex-limit-auto-reset/main/install.sh \
  | CODEX_RESET_REF=main bash
```

安装目录保存 `installation.json`、本地安装／卸载入口以及 `state/`。兑换幂等记录位于 `state/redemptions.json`，通知去重和补发历史位于 `state/notifications.sqlite`。Codex 凭据目录与安装目录必须独立，避免清理服务状态时误删登录凭据。

**卸载（默认保留配置和历史，便于重装）：**

```sh
bash "${XDG_DATA_HOME:-$HOME/.local/share}/codex-limit-auto-reset/uninstall.sh"
```

**彻底清理本服务的数据和本安装构建的闲置镜像：**

```sh
bash "${XDG_DATA_HOME:-$HOME/.local/share}/codex-limit-auto-reset/uninstall.sh" --purge --remove-images
```

自定义安装目录可直接执行该目录内的 `uninstall.sh`，它会识别所在目录；从仓库卸载则执行 `bash uninstall.sh --install-dir /your/install/path`。卸载可重复执行，不会删除 Codex 凭据、Docker、其他容器或 `--image` 指定的外部镜像。`--purge` 会删除通知历史和幂等记录，之后重新安装可能补发当前阶段的到期提醒。

迁移时同一账号只运行一个监控实例。脚本会拒绝覆盖不属于它的同名容器，也会检查本机其他容器是否挂载同一 Codex 凭据目录。现有手动／Compose 部署继续用原方式管理；例如 `docker compose down` 停止并移除 Compose 容器。脚本不会接管或卸载当前仓库的 Compose 服务。

查看服务：

```sh
docker ps --filter name=codex-limit-auto-reset
docker logs --tail 100 -f codex-limit-auto-reset
```

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

`pnpm check` also runs Python deployment tests against a stateful Docker fake. They cover missing Docker, inaccessible daemons, first install, login, upgrades, rollback, interrupted upgrades, piped bootstrap, conflicting containers, repeated uninstall, and credential/state preservation. These tests require Python 3.9+ and Bash.

For an optional real Docker lifecycle smoke test with fake credentials and no external Codex/Chirpy calls:

```sh
pnpm test:deployment:docker
# Reuse a local service image to skip building the base image:
python3 test/deployment_smoke.py --base-image codex-limit-auto-reset:local
```

## License

[MIT](./LICENSE)
