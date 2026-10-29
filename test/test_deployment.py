"""Run the real entrypoints against a stateful Docker fake; no live service changes."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import unittest

PROJECT = Path(__file__).resolve().parents[1]
FAKE_DOCKER = r'''
import json, os, sys
from pathlib import Path
args = sys.argv[1:]
path = Path(os.environ["FAKE_DOCKER_STATE"])
state = json.loads(path.read_text())
state["calls"].append(args)
def save(): path.write_text(json.dumps(state))
def finish(code=0, message=""):
    save()
    if message: print(message, file=sys.stderr if code else sys.stdout)
    sys.exit(code)
def value(flag, default=None):
    return args[args.index(flag)+1] if flag in args else default
def image_inspect(name):
    if name not in state["images"]: finish(1, "No such image: "+name)
    finish(message=json.dumps([state["images"][name]]))
if args == ["info"]:
    finish(1 if os.environ.get("FAKE_DOCKER_OFFLINE") else 0)
elif args[:2] == ["context", "inspect"]:
    finish(message="unix:///var/run/docker.sock")
elif args[:2] == ["container", "inspect"]:
    rows=[]
    for name in args[2:]:
        if name not in state["containers"]: finish(1, "Error: No such container: "+name)
        rows.append(state["containers"][name])
    finish(message=json.dumps(rows))
elif args[:2] == ["ps", "--quiet"]:
    finish(message="\n".join(k for k,v in state["containers"].items() if v["State"]["Running"]))
elif args[:2] == ["image", "inspect"]: image_inspect(args[2])
elif args[0] == "pull":
    state["images"][args[1]] = {"Config":{"Labels":{}}}
elif args[0] == "build":
    if os.environ.get("FAKE_BUILD_FAIL"): finish(1, "build failed")
    labels = dict(args[i+1].split("=",1) for i,a in enumerate(args) if a == "--label")
    state["images"][value("--tag")] = {"Config":{"Labels":labels}}
elif args[0] == "run":
    if "--rm" in args:
        if "--device-auth" in args:
            for i,a in enumerate(args):
                if a == "--mount" and "target=/data/codex" in args[i+1]:
                    source=args[i+1].split("source=",1)[1].split(",target=",1)[0]
                    Path(source,"auth.json").write_text('{"tokens":{}}')
        elif os.environ.get("FAKE_PREFLIGHT_FAIL"): finish(1, "account read failed")
        finish(message="preflight ok")
    labels = dict(args[i+1].split("=",1) for i,a in enumerate(args) if a == "--label")
    name = value("--name")
    if name in state["containers"]: finish(1, "name conflict")
    mounts=[]
    for i,a in enumerate(args):
        if a == "--mount":
            fields=dict(field.split("=",1) for field in args[i+1].split(","))
            mounts.append({"Source":fields["source"],"Destination":fields["target"]})
    state["containers"][name]={"Name":"/"+name,"Config":{"Labels":labels},"State":{"Running":True,"Status":"running"},"Mounts":mounts}
elif args[0] == "logs":
    if not os.environ.get("FAKE_HEALTH_FAIL"): finish(message="Account check succeeded; 2 available reset credits.")
    finish(message="Reset check failed; offline")
elif args[0] in ("stop","start"):
    name=args[-1]
    state["containers"][name]["State"]={"Running":args[0]=="start","Status":"running" if args[0]=="start" else "exited"}
elif args[0] == "rename":
    state["containers"][args[2]]=state["containers"].pop(args[1])
    state["containers"][args[2]]["Name"]="/"+args[2]
elif args[0] == "rm":
    state["containers"].pop(args[-1],None)
elif args[:2] == ["image","rm"]:
    state["images"].pop(args[2],None)
else: finish(2,"Unhandled Docker command: "+repr(args))
finish()
'''


class DeploymentTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="reset-install-test-")
        self.directory = Path(self.temp.name)
        self.root = self.directory / "install with spaces"
        self.credentials = self.directory / "codex with spaces"
        self.credentials.mkdir()
        (self.credentials / "auth.json").write_text('{"test":"keep credentials"}')
        self.binary = self.directory / "bin"
        self.binary.mkdir()
        self.state_path = self.directory / "docker.json"
        self.state_path.write_text(json.dumps({"calls": [], "containers": {}, "images": {}}))
        docker = self.binary / "docker"
        docker.write_text(f"#!{sys.executable}\n" + FAKE_DOCKER)
        docker.chmod(0o755)
        self.env = {**os.environ, "PATH": str(self.binary)+os.pathsep+os.environ["PATH"],
                    "FAKE_DOCKER_STATE": str(self.state_path)}

    def tearDown(self):
        self.temp.cleanup()

    def state(self):
        return json.loads(self.state_path.read_text())

    def run_script(self, script, *arguments, extra_env=None):
        result = subprocess.run(["bash", str(PROJECT / script), "--install-dir", str(self.root), *arguments],
                                env={**self.env, **(extra_env or {})}, text=True, capture_output=True, timeout=20)
        return result

    def install(self, *arguments, extra_env=None):
        return self.run_script("install.sh", "--codex-home", str(self.credentials), "--no-login", *arguments,
                               extra_env=extra_env)

    def assert_success(self, result):
        self.assertEqual(result.returncode, 0, result.stdout+result.stderr)

    def record(self):
        return json.loads((self.root / "installation.json").read_text())

    def test_install_checks_account_before_start_and_preserves_credentials(self):
        self.assert_success(self.install())
        calls = self.state()["calls"]
        check = next(i for i,c in enumerate(calls) if "dist/cli.js" in c)
        start = next(i for i,c in enumerate(calls) if "--detach" in c)
        self.assertLess(check, start)
        self.assertIn("unless-stopped", calls[start])
        self.assertIn("REDEEM_BEFORE_MINUTES=1", calls[start])
        self.assertIn("--user", calls[start])
        self.assertEqual(json.loads((self.credentials / "auth.json").read_text()), {"test":"keep credentials"})
        self.assertTrue((self.root / "uninstall.sh").is_file())

    def test_missing_docker_is_only_an_error_and_writes_nothing(self):
        (self.binary / "docker").unlink()
        (self.binary / "python3").symlink_to(sys.executable)
        result = subprocess.run(["/bin/bash", str(PROJECT / "install.sh"), "--install-dir", str(self.root)],
                                env={**self.env, "PATH": str(self.binary)}, text=True, capture_output=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("缺少 docker", result.stderr)
        self.assertFalse(self.root.exists())

    def test_inaccessible_daemon_does_not_install_or_start_docker(self):
        result = self.install(extra_env={"FAKE_DOCKER_OFFLINE":"1"})
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Docker 不可用", result.stderr)
        self.assertEqual(self.state()["calls"], [["info"]])
        self.assertFalse(self.root.exists())

    def test_remote_docker_is_rejected_before_using_local_credentials(self):
        result = self.install(extra_env={"DOCKER_HOST":"ssh://remote-server"})
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("本机 Docker", result.stderr)
        self.assertFalse(self.root.exists())

    def test_upgrade_keeps_state_and_configuration(self):
        self.assert_success(self.install("--timezone", "Asia/Shanghai", "--redeem-before-minutes", "2"))
        (self.root / "state" / "redemptions.json").write_text("persistent key")
        previous = self.record()["revision"]
        self.assert_success(self.install())
        self.assertEqual((self.root / "state" / "redemptions.json").read_text(), "persistent key")
        self.assertEqual(self.record()["config"]["timezone"], "Asia/Shanghai")
        self.assertEqual(self.record()["config"]["minutes"], 2)
        self.assertNotEqual(self.record()["revision"], previous)
        self.assertEqual(list(self.state()["containers"]), ["codex-limit-auto-reset"])

    def test_build_and_account_failures_leave_old_service_running(self):
        self.assert_success(self.install())
        previous = self.state()["containers"]
        for failure in ("FAKE_BUILD_FAIL", "FAKE_PREFLIGHT_FAIL"):
            with self.subTest(failure=failure):
                result = self.install(extra_env={failure:"1"})
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(self.state()["containers"], previous)

    def test_failed_start_rolls_back_container_and_config(self):
        self.assert_success(self.install())
        previous = self.record()
        containers = self.state()["containers"]
        result = self.install("--timezone", "UTC", "--health-timeout", "1", extra_env={"FAKE_HEALTH_FAIL":"1"})
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.state()["containers"], containers)
        self.assertEqual(self.record()["revision"], previous["revision"])
        self.assertEqual(self.record()["config"], previous["config"])
        self.assertFalse((self.root / "transaction.json").exists())

    def test_failed_first_start_removes_only_the_candidate(self):
        result = self.install("--health-timeout", "1", extra_env={"FAKE_HEALTH_FAIL":"1"})
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(self.state()["containers"])
        self.assertEqual(self.record()["revision"], "")
        self.assertTrue((self.credentials / "auth.json").is_file())

    def test_nonempty_unowned_directory_is_not_used_or_purged(self):
        self.root.mkdir()
        existing = self.root / "important.txt"
        existing.write_text("keep")
        self.assertNotEqual(self.install().returncode, 0)
        self.assertNotEqual(self.run_script("uninstall.sh", "--purge").returncode, 0)
        self.assertEqual(existing.read_text(), "keep")

    def test_existing_unmanaged_container_is_never_replaced(self):
        data = self.state()
        data["containers"]["codex-limit-auto-reset"] = {"Config":{"Labels":{}}, "State":{"Running":True}}
        self.state_path.write_text(json.dumps(data))
        result = self.install()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("不属于此安装", result.stderr)
        self.assertFalse(any(c[0] in ("build", "run", "stop", "rm") for c in self.state()["calls"]))

    def test_uninstall_and_reinstall_keep_history_and_purge_keeps_credentials(self):
        self.assert_success(self.install())
        history = self.root / "state" / "notifications.sqlite"
        history.write_text("notification history")
        self.assert_success(self.run_script("uninstall.sh"))
        self.assertFalse(self.state()["containers"])
        self.assertEqual(history.read_text(), "notification history")
        self.assert_success(self.run_script("uninstall.sh"))
        self.assert_success(self.install())
        self.assertEqual(history.read_text(), "notification history")
        self.assert_success(self.run_script("uninstall.sh", "--purge", "--remove-images"))
        self.assertFalse(self.root.exists())
        self.assertFalse(self.state()["images"])
        self.assertTrue((self.credentials / "auth.json").is_file())
        self.assert_success(self.run_script("uninstall.sh", "--purge"))

    def test_installed_uninstaller_infers_custom_directory(self):
        self.assert_success(self.install())
        result = subprocess.run(["bash", str(self.root / "uninstall.sh")], env=self.env, text=True, capture_output=True)
        self.assert_success(result)
        self.assertFalse(self.state()["containers"])

    def test_credentials_must_be_outside_installation_directory(self):
        result = self.run_script("install.sh", "--codex-home", str(self.root / "codex"))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("不能嵌套", result.stderr)
        self.assertFalse(self.root.exists())

    def test_device_login_when_credentials_are_missing(self):
        (self.credentials / "auth.json").unlink()
        self.assert_success(self.run_script("install.sh", "--codex-home", str(self.credentials)))
        self.assertTrue(any("--device-auth" in call for call in self.state()["calls"]))
        self.assertTrue((self.credentials / "auth.json").is_file())

    def test_no_login_mode_stops_before_launch_when_credentials_are_missing(self):
        (self.credentials / "auth.json").unlink()
        result = self.install()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("缺少", result.stderr)
        self.assertFalse(any("--detach" in call or "--device-auth" in call for call in self.state()["calls"]))

    def test_duplicate_credentials_in_another_container_are_rejected(self):
        data = self.state()
        data["containers"]["other-monitor"] = {"Name":"/other-monitor", "Config":{"Labels":{}},
            "State":{"Running":True}, "Mounts":[{"Source":str(self.credentials),"Destination":"/data/codex"}]}
        self.state_path.write_text(json.dumps(data))
        result = self.install("--name", "new-monitor")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("相同 Codex 凭据", result.stderr)
        self.assertFalse(self.root.exists())

    def test_interrupted_upgrade_is_recovered_before_retrying(self):
        self.assert_success(self.install())
        record = self.record()
        data = self.state()
        backup = "codex-limit-auto-reset-previous-interrupted"
        old = data["containers"].pop("codex-limit-auto-reset")
        old["Name"] = "/"+backup
        old["State"] = {"Running":False,"Status":"exited"}
        data["containers"][backup] = old
        self.state_path.write_text(json.dumps(data))
        (self.root / "transaction.json").write_text(json.dumps({"revision":"interrupted","backup":backup,"was_running":True}))
        result = self.install(extra_env={"FAKE_BUILD_FAIL":"1"})
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.record()["revision"], record["revision"])
        self.assertTrue(self.state()["containers"]["codex-limit-auto-reset"]["State"]["Running"])
        self.assertNotIn(backup, self.state()["containers"])
        self.assertFalse((self.root / "transaction.json").exists())

    def test_prebuilt_image_is_never_deleted_by_uninstall(self):
        self.assert_success(self.install("--image", "example/service:1"))
        self.assertFalse(any(call[0] == "build" for call in self.state()["calls"]))
        self.assert_success(self.run_script("uninstall.sh", "--purge", "--remove-images"))
        self.assertIn("example/service:1", self.state()["images"])

    def test_piped_bootstrap_forwards_arguments_and_installs_local_helpers(self):
        archive = self.directory / "source.tar.gz"
        with tarfile.open(archive, "w:gz") as output:
            for name in ("install.sh", "uninstall.sh", "scripts/deploy.py", "Dockerfile"):
                output.add(PROJECT / name, arcname="release/"+name)
        curl = self.binary / "curl"
        curl.write_text(f"#!{sys.executable}\nimport shutil,sys\nshutil.copyfile({str(archive)!r},sys.argv[sys.argv.index('--output')+1])\n")
        curl.chmod(0o755)
        result = subprocess.run(["bash", "-s", "--", "--install-dir", str(self.root), "--codex-home", str(self.credentials), "--timezone", "UTC", "--no-login"],
                                input=(PROJECT / "install.sh").read_text(), env=self.env, text=True, capture_output=True, timeout=20)
        self.assert_success(result)
        self.assertEqual(self.record()["config"]["timezone"], "UTC")
        self.assertTrue((self.root / "scripts" / "deploy.py").is_file())


if __name__ == "__main__":
    unittest.main()
