#!/usr/bin/env bash
# Wait for the GitHub Actions run for the current HEAD and print failed logs on error.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if ! command -v gh >/dev/null 2>&1; then
  echo "gh CLI not found (install from https://cli.github.com/)" >&2
  exit 1
fi

if ! gh auth status >/dev/null 2>&1; then
  if [[ -z "${GH_TOKEN:-}" ]]; then
    TOKEN="$(printf 'protocol=https\nhost=github.com\n\n' | git credential fill 2>/dev/null | awk -F= '/^password=/{print $2; exit}')"
    if [[ -n "${TOKEN:-}" ]]; then
      export GH_TOKEN="$TOKEN"
    fi
  fi
fi

SHA="$(git rev-parse HEAD)"
REPO="$(gh repo view --json nameWithOwner --jq .nameWithOwner 2>/dev/null || true)"
if [[ -z "${REPO:-}" ]]; then
  REPO="shaowenchen/storage-console"
fi

echo "Waiting for Actions run for $SHA ($REPO) ..."

# Poll until a run appears for this SHA (push webhook can lag a few seconds).
RUN_ID=""
for _ in $(seq 1 45); do
  RUN_ID="$(gh run list --repo "$REPO" --commit "$SHA" --workflow CI --limit 1 --json databaseId --jq '.[0].databaseId // empty')"
  if [[ -n "$RUN_ID" ]]; then
    break
  fi
  # Fallback without workflow filter (renamed workflows / first push).
  RUN_ID="$(gh run list --repo "$REPO" --commit "$SHA" --limit 1 --json databaseId --jq '.[0].databaseId // empty')"
  if [[ -n "$RUN_ID" ]]; then
    break
  fi
  sleep 2
done

if [[ -z "${RUN_ID:-}" ]]; then
  echo "No Actions run found for $SHA" >&2
  exit 1
fi

echo "Run: https://github.com/$REPO/actions/runs/$RUN_ID"

if gh run watch "$RUN_ID" --repo "$REPO" --exit-status; then
  echo "CI passed."
  exit 0
fi

echo "CI failed. Failed job logs:" >&2
gh run view "$RUN_ID" --repo "$REPO" --log-failed || true
exit 1
