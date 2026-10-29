#!/usr/bin/env python3
"""Install/upgrade/uninstall using an existing local Docker daemon, no host packages."""
from __future__ import annotations

import argparse
import contextlib
import fcntl
import json
import os
from pathlib import Path
import re
import shutil
import shlex
import signal
import subprocess
import sys
import tempfile
import time
import uuid

APP = "codex-limit-auto-reset"
LABEL = "io.linncy.codex-reset.install-id"
REVISION_LABEL = "io.linncy.codex-reset.revision"
SOURCE = Path(__file__).resolve().parent.parent


class DeploymentError(RuntimeError):
    pass


def execute(command, *, capture=False, timeout=600):
    try:
        return subprocess.run(command, text=True, stdout=subprocess.PIPE if capture else None,
                              stderr=subprocess.PIPE if capture else None, timeout=timeout)
    except (OSError, subprocess.TimeoutExpired) as error:
        raise DeploymentError(f"命令无法完成：{command[0]} ({error})") from error


def checked(command, *, capture=False, timeout=600):
    result = execute(command, capture=capture, timeout=timeout)
    if result.returncode:
        raise DeploymentError(f"命令失败（退出码 {result.returncode}）：{' '.join(command[:3])}\n"
                              f"{(result.stderr or '')[-2000:]}")
    return result.stdout or ""


def docker_ready():
    if sys.platform != "linux":
        raise DeploymentError("安装脚本支持 Linux 服务器；其他系统请使用 README 中的 Docker 命令。")
    if not shutil.which("docker"):
        raise DeploymentError("未找到 Docker。请自行安装 Docker 后重试；脚本不会安装或升级 Docker。")
    if execute(["docker", "info"], capture=True, timeout=20).returncode:
        raise DeploymentError("Docker 不可用：请检查 daemon 是否启动，以及当前用户的 Docker 权限/连接配置。"
                              "脚本不会启动、安装或修改 Docker；可在配置好权限后重试。")
    endpoint = os.environ.get("DOCKER_HOST") or checked(
        ["docker", "context", "inspect", "--format", '{{.Endpoints.docker.Host}}'], capture=True, timeout=20).strip()
    if not endpoint.startswith("unix://"):
        raise DeploymentError("需要本机 Docker Unix socket；不支持远程 Docker context/DOCKER_HOST 的本地目录挂载。")


def inspect(name):
    result = execute(["docker", "container", "inspect", name], capture=True, timeout=20)
    if result.returncode:
        if "No such" in (result.stderr or ""):
            return None
        raise DeploymentError(f"无法检查容器 {name}：{result.stderr}")
    return json.loads(result.stdout)[0]


def owned_container(name, record):
    container = inspect(name)
    if container and container["Config"].get("Labels", {}).get(LABEL) != record["id"]:
        raise DeploymentError(f"容器 {name} 不属于此安装，拒绝覆盖或删除。请更换 --name 或先处理原部署。")
    return container


def write_record(path, record):
    fd, temporary = tempfile.mkstemp(prefix=".install-", dir=path.parent)
    try:
        with os.fdopen(fd, "w") as output:
            json.dump(record, output, indent=2, ensure_ascii=False)
            output.write("\n")
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
        directory_fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    finally:
        Path(temporary).unlink(missing_ok=True)


def read_record(root):
    path = root / "installation.json"
    if not path.exists():
        if root.exists() and any(root.iterdir()):
            raise DeploymentError(f"目录非空且不属于本安装脚本：{root}")
        return None
    record = json.loads(path.read_text())
    if (not isinstance(record, dict) or record.get("app") != APP or record.get("version") != 1
            or not isinstance(record.get("id"), str) or not record["id"]
            or not isinstance(record.get("config"), dict) or not isinstance(record.get("images"), list)):
        raise DeploymentError(f"安装记录格式无效：{path}")
    if record.get("root") != str(root):
        raise DeploymentError("安装目录已移动；请使用原安装目录，以免操作错误的容器或状态文件。")
    return record


@contextlib.contextmanager
def installation_lock(root):
    root.parent.mkdir(parents=True, exist_ok=True)
    # Outside the removable installation, so purge cannot replace a held lock.
    with (root.parent / f".{root.name}.install.lock").open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise DeploymentError("另一个安装/卸载任务正在运行，请稍后重试。") from error
        yield


def container_options(root, record, revision):
    config = record["config"]
    return ["--label", f"{LABEL}={record['id']}", "--label", f"{REVISION_LABEL}={revision}",
            "--user", f"{os.getuid()}:{os.getgid()}",
            "--mount", f"type=bind,source={config['codex_home']},target=/data/codex",
            "--mount", f"type=bind,source={root / 'state'},target=/data/reset",
            "--env", "STATE_FILE=/data/reset/redemptions.json",
            "--env", "NOTIFICATION_STATE_FILE=/data/reset/notifications.sqlite",
            "--env", f"NOTIFICATION_TIMEZONE={config['timezone']}",
            "--env", f"REDEEM_BEFORE_MINUTES={config['minutes']}"]


def ephemeral(root, record, image, entrypoint, arguments, *, timeout=90):
    name = f"{record['config']['name']}-check-{uuid.uuid4().hex[:8]}"
    try:
        checked(["docker", "run", "--rm", "--name", name,
                 *container_options(root, record, "check"), "--entrypoint", entrypoint,
                 image, *arguments], timeout=timeout)
    finally:
        if owned_container(name, record):
            checked(["docker", "rm", "--force", name], capture=True)


def rollback(root, record):
    journal_file = root / "transaction.json"
    if not journal_file.exists():
        return
    transaction = json.loads(journal_file.read_text())
    name, backup = record["config"]["name"], transaction["backup"]
    previous = owned_container(backup, record)
    current = owned_container(name, record)
    if record.get("revision") == transaction["revision"]:
        # The durable install record commits the new version after health checks.
        if previous:
            checked(["docker", "rm", backup], capture=True)
    else:
        if current and current["Config"].get("Labels", {}).get(REVISION_LABEL) == transaction["revision"]:
            checked(["docker", "rm", "--force", name], capture=True)
            current = None
        if previous:
            if current:
                raise DeploymentError("恢复升级时发现冲突容器，请保留安装记录并人工检查。")
            checked(["docker", "rename", backup, name], capture=True)
            current = previous
        if current and transaction["was_running"]:
            checked(["docker", "start", name], capture=True)
        print("已恢复升级前的容器状态。", flush=True)
    journal_file.unlink()


def wait_healthy(name, timeout):
    deadline = time.monotonic() + timeout
    logs = ""
    while time.monotonic() < deadline:
        container = inspect(name)
        if not container or container["State"]["Status"] in ("exited", "dead"):
            break
        result = execute(["docker", "logs", "--tail", "100", name], capture=True, timeout=20)
        logs = (result.stdout or "") + (result.stderr or "")
        if result.returncode:
            raise DeploymentError(f"无法读取服务启动日志：{logs}")
        if container["State"].get("Running") and "Account check succeeded;" in logs:
            return
        time.sleep(0.5)
    raise DeploymentError(f"服务未在 {timeout} 秒内完成额度检查，安装/升级将回退。\n{logs[-3000:]}")


def install(root, args):
    previous_record = read_record(root)
    record = previous_record or {"app": APP, "version": 1, "id": uuid.uuid4().hex,
                                  "root": str(root), "revision": "", "images": []}
    old_config = record.get("config", {})
    config = {
        "name": args.name or old_config.get("name", APP),
        "codex_home": str(Path(args.codex_home or old_config.get("codex_home", "~/.codex")).expanduser().resolve()),
        "timezone": args.timezone or old_config.get("timezone", "America/Los_Angeles"),
        "minutes": args.redeem_before_minutes or old_config.get("minutes", 1),
    }
    if not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9_.-]{0,90}", config["name"]):
        raise DeploymentError("--name 必须是有效 Docker 容器名（不超过 91 个字符）。")
    codex_home = Path(config["codex_home"])
    if root == codex_home or root in codex_home.parents or codex_home in root.parents:
        raise DeploymentError("安装目录和 Codex 凭据目录必须相互独立，不能嵌套。")
    if any(character in str(path) for path in (root, codex_home) for character in (",", "\n", "\r")):
        raise DeploymentError("安装/凭据路径不能包含逗号或换行（Docker bind mount 限制）。")
    if previous_record:
        for key in ("name", "codex_home"):
            if config[key] != old_config[key]:
                raise DeploymentError(f"升级不能改变 {key}；请使用单独的安装目录。")
        rollback(root, previous_record)
    record = {**record, "config": config}
    name = config["name"]
    old_container = owned_container(name, record)
    # Prevent two local monitors from using the same credentials/state account.
    ids = checked(["docker", "ps", "--quiet"], capture=True).split()
    if ids:
        for container in json.loads(checked(["docker", "container", "inspect", *ids], capture=True)):
            if container.get("Name", "").lstrip("/") == name:
                continue
            if any(mount.get("Destination") == "/data/codex" and Path(mount.get("Source", "")).resolve() == codex_home
                   for mount in container.get("Mounts", [])):
                raise DeploymentError(f"已有容器 {container['Name']} 使用相同 Codex 凭据，请勿重复运行。")

    root.mkdir(parents=True, exist_ok=True)
    (root / "state").mkdir(exist_ok=True)
    codex_home.mkdir(parents=True, exist_ok=True)
    if previous_record is None:
        write_record(root / "installation.json", record)
    revision = uuid.uuid4().hex[:12]
    image = args.image or f"{APP}:install-{record['id'][:8]}-{revision}"
    if args.image:
        if execute(["docker", "image", "inspect", image], capture=True).returncode:
            checked(["docker", "pull", image], timeout=900)
    else:
        print("构建服务镜像（Node.js / Codex CLI 均在镜像内）…", flush=True)
        checked(["docker", "build", "--label", f"{LABEL}={record['id']}", "--tag", image, str(SOURCE)], timeout=1800)
        record["images"] = [*record["images"], image]
        # Retain ownership of built images even if the subsequent login fails.
        saved = {**(previous_record or record), "images": record["images"]}
        write_record(root / "installation.json", saved)
    if not (codex_home / "auth.json").is_file():
        if args.no_login:
            raise DeploymentError(f"缺少 {codex_home / 'auth.json'}；请先登录 ChatGPT 或去掉 --no-login。")
        print("尚未发现文件登录凭据；请按 Codex 输出的链接和设备码完成 ChatGPT 登录…", flush=True)
        ephemeral(root, record, image, "codex",
                  ["login", "--device-auth", "-c", 'cli_auth_credentials_store="file"'], timeout=900)
    print("验证配置、文件写入权限和账户额度（此检查不会兑换重置券）…", flush=True)
    ephemeral(root, record, image, "node", ["--input-type=module", "-e",
        'import {parseConfig} from "./dist/config.js"; import {mkdtemp,rm} from "node:fs/promises"; '
        'parseConfig(process.env); const p=await mkdtemp("/data/reset/.probe-"); await rm(p,{recursive:true});'])
    ephemeral(root, record, image, "node", ["dist/cli.js"])

    backup = f"{name}-previous-{revision}"
    journal = {"revision": revision, "backup": backup,
               "was_running": bool(old_container and old_container["State"].get("Running"))}
    write_record(root / "transaction.json", journal)
    try:
        if old_container:
            checked(["docker", "stop", "--time", "20", name], capture=True)
            checked(["docker", "rename", name, backup], capture=True)
        checked(["docker", "run", "--detach", "--name", name, "--restart", "unless-stopped", "--init",
                 "--log-opt", "max-size=10m", "--log-opt", "max-file=3",
                 *container_options(root, record, revision), image], capture=True)
        wait_healthy(name, args.health_timeout)
        # Keep local uninstall/upgrade entrypoints after a remote bootstrap exits.
        (root / "scripts").mkdir(exist_ok=True)
        for source, target in ((SOURCE / "install.sh", root / "install.sh"),
                               (SOURCE / "uninstall.sh", root / "uninstall.sh"),
                               (Path(__file__).resolve(), root / "scripts" / "deploy.py")):
            if source.resolve() != target.resolve():
                shutil.copyfile(source, target)
        record.update(revision=revision, image=image, installed=True)
        write_record(root / "installation.json", record)
    except BaseException:
        rollback(root, read_record(root))
        raise
    rollback(root, record)
    print(f"安装完成，账户额度检查成功。\n容器：{name}\n安装/状态目录：{root}\n"
          f"Codex 凭据：{codex_home}\n查看日志：docker logs --tail 100 -f {name}\n"
          f"卸载：bash {shlex.quote(str(root / 'uninstall.sh'))} --install-dir {shlex.quote(str(root))}", flush=True)


def uninstall(root, args):
    record = read_record(root)
    if record is None:
        print("未发现本脚本的安装记录，无需卸载。")
        return
    rollback(root, record)
    name = record["config"]["name"]
    if owned_container(name, record):
        checked(["docker", "stop", "--time", "20", name], capture=True)
        checked(["docker", "rm", name], capture=True)
    if args.remove_images:
        for image in record["images"]:
            result = execute(["docker", "image", "inspect", image], capture=True)
            if result.returncode:
                continue
            data = json.loads(result.stdout)[0]
            if data.get("Config", {}).get("Labels", {}).get(LABEL) == record["id"]:
                result = execute(["docker", "image", "rm", image], capture=True)
                if result.returncode:
                    print(f"镜像未删除（可能仍被引用）：{image}\n{result.stderr}")
    record["installed"] = False
    write_record(root / "installation.json", record)
    if args.purge:
        credentials = Path(record["config"]["codex_home"]).resolve()
        if root == credentials or root in credentials.parents:
            raise DeploymentError("凭据目录位于安装目录内，拒绝清理。")
        shutil.rmtree(root)
        print("已卸载并清理此安装的配置和历史状态。")
    else:
        print(f"已卸载容器；配置、兑换幂等记录和通知历史保留在 {root}，可直接重新安装。")
    print(f"Codex 凭据保留在 {record['config']['codex_home']}；Docker 和其他容器未移除。")


def main():
    parser = argparse.ArgumentParser(description="Codex 自动重置服务：使用现有 Docker 安装/卸载，不安装系统依赖。")
    commands = parser.add_subparsers(dest="action", required=True)
    install_parser = commands.add_parser("install", help="安装或升级服务")
    uninstall_parser = commands.add_parser("uninstall", help="卸载本脚本管理的服务")
    default_root = (SOURCE if (SOURCE / "installation.json").is_file() else
                    Path(os.environ.get("XDG_DATA_HOME", str(Path.home() / ".local/share"))) / APP)
    for command in (install_parser, uninstall_parser):
        command.add_argument("--install-dir", default=str(default_root), help="安装目录（升级/卸载时使用同一目录）")
    install_parser.add_argument("--name", help="容器名，默认 codex-limit-auto-reset")
    install_parser.add_argument("--codex-home", help="Codex 登录目录，默认 ~/.codex")
    install_parser.add_argument("--timezone", help="提醒时区，默认 America/Los_Angeles")
    install_parser.add_argument("--redeem-before-minutes", type=int, help="过期前多少分钟兑换，默认 1")
    install_parser.add_argument("--image", help="使用指定镜像，省略则构建当前源码")
    install_parser.add_argument("--no-login", action="store_true", help="缺少文件登录凭据时退出，不启动设备码登录")
    install_parser.add_argument("--health-timeout", type=int, default=45, help="启动后等待额度检查成功的秒数，默认 45")
    uninstall_parser.add_argument("--purge", action="store_true", help="同时删除此安装目录及历史状态；始终保留 Codex 凭据")
    uninstall_parser.add_argument("--remove-images", action="store_true", help="删除此安装构建且没有其他容器使用的镜像")
    args = parser.parse_args()
    root = Path(args.install_dir).expanduser().resolve()
    if root in (Path("/"), Path.home()) or ((SOURCE / "Dockerfile").is_file() and (root == SOURCE or root in SOURCE.parents)):
        raise DeploymentError("请使用独立安装目录，不能使用根目录、用户主目录或源码目录。")
    if args.action == "install":
        if args.redeem_before_minutes is not None and args.redeem_before_minutes < 1:
            raise DeploymentError("--redeem-before-minutes 必须至少为 1。")
        if args.health_timeout < 1:
            raise DeploymentError("--health-timeout 必须为正数。")
    elif not root.exists():
        print("安装目录不存在，无需卸载。")
        return
    docker_ready()
    with installation_lock(root):
        if args.action == "install":
            install(root, args)
        else:
            uninstall(root, args)


def interrupt(_signal, _frame):
    raise KeyboardInterrupt()


if __name__ == "__main__":
    signal.signal(signal.SIGTERM, interrupt)
    try:
        main()
    except (DeploymentError, OSError, ValueError, KeyError) as error:
        print(f"错误：{error}", file=sys.stderr)
        sys.exit(1)
    except KeyboardInterrupt:
        print("操作已取消。", file=sys.stderr)
        sys.exit(130)
