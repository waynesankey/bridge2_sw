#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PICO_DIR="$ROOT_DIR/pico"

rm -rf "$PICO_DIR"
mkdir -p "$PICO_DIR/web"

cp -f "$ROOT_DIR/main.py" "$ROOT_DIR/config.py" "$PICO_DIR/"

shopt -s nullglob
for f in "$ROOT_DIR"/lib/*.py; do
  [[ "$(basename "$f")" == "__init__.py" ]] && continue
  cp -f "$f" "$PICO_DIR/web/"
done
