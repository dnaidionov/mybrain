#!/bin/sh
# Verifies that server.mjs and templates/server.mjs are identical.
# Run before committing changes to either file.
set -e

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

if ! diff -q "$ROOT/server.mjs" "$ROOT/templates/server.mjs" > /dev/null 2>&1; then
  echo "ERROR: server.mjs and templates/server.mjs are out of sync."
  echo ""
  diff "$ROOT/server.mjs" "$ROOT/templates/server.mjs" || true
  echo ""
  echo "Edit one file, then copy it to the other before committing."
  exit 1
fi

echo "OK: server.mjs and templates/server.mjs are in sync."
