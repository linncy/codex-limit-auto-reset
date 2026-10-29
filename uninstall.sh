#!/usr/bin/env bash
set -euo pipefail
project_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
command -v python3 >/dev/null 2>&1 || { printf '%s\n' '缺少 python3，请安装后重试。' >&2; exit 1; }
exec python3 "$project_dir/scripts/deploy.py" uninstall "$@"
