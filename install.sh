#!/usr/bin/env bash
# Works from a checkout, an installed copy, or curl | bash.
set -euo pipefail

for required in docker python3; do
  if ! command -v "$required" >/dev/null 2>&1; then
    printf '缺少 %s，请先自行安装后重试。本脚本不会安装 Docker。\n' "$required" >&2
    exit 1
  fi
done

source_file="${BASH_SOURCE[0]:-}"
project_dir=""
if [[ -n "$source_file" && -f "$source_file" ]]; then
  project_dir="$(cd -- "$(dirname -- "$source_file")" && pwd -P)"
fi
if [[ -n "$project_dir" && -f "$project_dir/Dockerfile" && -f "$project_dir/scripts/deploy.py" ]]; then
  exec python3 "$project_dir/scripts/deploy.py" install "$@"
fi

for required in curl tar; do
  command -v "$required" >/dev/null 2>&1 || { printf '缺少 %s，请安装后重试。\n' "$required" >&2; exit 1; }
done
download_dir="$(mktemp -d)"
trap 'rm -rf -- "$download_dir"' EXIT
release_ref="${CODEX_RESET_REF:-main}"
curl --fail --silent --show-error --location --retry 3 \
  "https://api.github.com/repos/linncy/codex-limit-auto-reset/tarball/$release_ref" \
  --output "$download_dir/source.tar.gz"
mkdir "$download_dir/source"
tar -xzf "$download_dir/source.tar.gz" --strip-components=1 -C "$download_dir/source"
if [[ -n "$project_dir" && -f "$project_dir/installation.json" ]]; then
  python3 "$download_dir/source/scripts/deploy.py" install --install-dir "$project_dir" "$@"
else
  python3 "$download_dir/source/scripts/deploy.py" install "$@"
fi
