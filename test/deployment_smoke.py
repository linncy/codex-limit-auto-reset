"""Opt-in real Docker lifecycle test with fake auth/RPC, no Codex/Chirpy calls."""
import argparse
import json
from pathlib import Path
import subprocess
import tempfile
import uuid

PROJECT = Path(__file__).resolve().parents[1]


def run(*command, check=True):
    return subprocess.run(command, cwd=PROJECT, check=check, timeout=1800)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-image", help="Reuse an already-built service image; otherwise build from this checkout")
    args = parser.parse_args()
    suffix = uuid.uuid4().hex[:10]
    name = f"codex-reset-install-test-{suffix}"
    base = args.base_image or f"codex-limit-auto-reset:smoke-base-{suffix}"
    fixture = f"codex-limit-auto-reset:smoke-{suffix}"
    with tempfile.TemporaryDirectory(prefix="reset-install-smoke-") as temporary:
        directory = Path(temporary)
        root, credentials = directory / "installed with spaces", directory / "codex with spaces"
        credentials.mkdir()
        auth = credentials / "auth.json"
        auth.write_text('{"fixture":true}')
        (directory / "Dockerfile").write_text(f"FROM {base}\nCOPY main.mjs /app/dist/main.js\nCOPY cli.mjs /app/dist/cli.js\n")
        (directory / "main.mjs").write_text('''
import { existsSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
if (!existsSync(process.env.STATE_FILE)) writeFileSync(process.env.STATE_FILE, '{"fixture":"persistent"}');
const db = new DatabaseSync(process.env.NOTIFICATION_STATE_FILE);
db.exec("CREATE TABLE IF NOT EXISTS smoke (value TEXT); INSERT INTO smoke VALUES ('persistent');");
db.close();
console.log("Account check succeeded; 0 available reset credits. Fixture only.");
setInterval(() => {}, 60000);
process.on("SIGTERM", () => process.exit(0));
''')
        (directory / "cli.mjs").write_text('''
import { accessSync } from "node:fs";
accessSync("/data/codex/auth.json");
console.log("Read-only fixture account check succeeded; no external API calls.");
''')
        try:
            if not args.base_image:
                run("docker", "build", "-t", base, str(PROJECT))
            run("docker", "build", "-t", fixture, str(directory))
            install = ["bash", str(PROJECT / "install.sh"), "--install-dir", str(root), "--codex-home", str(credentials),
                       "--name", name, "--image", fixture, "--no-login"]
            run(*install)
            state = root / "state" / "redemptions.json"
            assert json.loads(state.read_text()) == {"fixture":"persistent"}
            state.write_text('{"fixture":"must survive upgrade"}')
            run(*install)
            assert json.loads(state.read_text()) == {"fixture":"must survive upgrade"}
            run("bash", str(root / "uninstall.sh"))
            assert state.is_file() and (root / "state" / "notifications.sqlite").is_file()
            run("bash", str(root / "uninstall.sh"), "--purge", "--remove-images")
            assert not root.exists()
            assert json.loads(auth.read_text()) == {"fixture":True}
            run("bash", str(PROJECT / "uninstall.sh"), "--install-dir", str(root), "--purge")
            print("PASS: real Docker install, upgrade, preserved state, uninstall, purge and repeat uninstall.")
        finally:
            subprocess.run(["docker", "rm", "--force", name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            run("docker", "image", "rm", fixture, check=False)
            if not args.base_image:
                run("docker", "image", "rm", base, check=False)


if __name__ == "__main__":
    main()
