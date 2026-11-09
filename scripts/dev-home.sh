#!/usr/bin/env bash
set -euo pipefail
MIKO_DEV_ROOT="$(git rev-parse --show-toplevel)"
export MIKO_HOME="${MIKO_HOME:-${MIKO_DEV_ROOT}/.dev/miko-home}"
export PASEO_HOME="$MIKO_HOME"
export PASEO_LISTEN="${PASEO_LISTEN:-127.0.0.1:7768}"
exec "$@"
