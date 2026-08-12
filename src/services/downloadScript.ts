export interface DirectDownloadScriptConfig {
  apiBase: string;
  bucketId: string;
  key: string;
  output?: string;
}

function shellQuote(value: string): string {
  return `'${String(value || '').replace(/'/g, `'\\''`)}'`;
}

/**
 * Bash+Python CLI that mints a short-lived signed GET URL then downloads
 * the object directly from the bucket (same pattern as getagents).
 */
export function directDownloadShellScript(config: DirectDownloadScriptConfig): string {
  const defaultOutput = config.key.split('/').filter(Boolean).pop() || 'download.bin';
  return `set -euo pipefail

API_BASE=${shellQuote(config.apiBase)}
BUCKET_ID=${shellQuote(config.bucketId)}
OBJECT_KEY=${shellQuote(config.key)}
DEFAULT_OUTPUT=${shellQuote(config.output || defaultOutput)}
OUTPUT="${'${OUTPUT:-$DEFAULT_OUTPUT}'}"

DOWNLOAD_KEY="${'${STORAGE_CONSOLE_DOWNLOAD_KEY:-${STUDIO_DOWNLOAD_KEY:-}}'}"
if [ -z "${'$'}DOWNLOAD_KEY" ]; then
  echo "Set STORAGE_CONSOLE_DOWNLOAD_KEY to your download API key." >&2
  exit 1
fi

python3 - "$API_BASE" "$DOWNLOAD_KEY" "$BUCKET_ID" "$OBJECT_KEY" "$OUTPUT" <<'PY'
import json
import os
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request

api_base, token, bucket_id, object_key, output = sys.argv[1:]

def fail(message):
    print(message, file=sys.stderr)
    sys.exit(1)

path = (
    f"/storages/{urllib.parse.quote(bucket_id)}/download-object-link"
    f"?key={urllib.parse.quote(object_key, safe='')}"
)
req = urllib.request.Request(
    api_base + path,
    headers={"X-API-Key": token},
    method="GET",
)
try:
    with urllib.request.urlopen(req) as response:
        data = json.loads(response.read().decode("utf-8") or "{}")
except urllib.error.HTTPError as exc:
    body = exc.read().decode("utf-8", "replace")
    fail(f"API failed ({exc.code}): {body}")

url = data.get("url") or ""
if not url:
    fail("Failed to obtain direct download URL.")

print(f"Direct download {object_key} -> {output}")
os.makedirs(os.path.dirname(output) or ".", exist_ok=True)
subprocess.run(
    ["curl", "--fail", "--silent", "--show-error", "--location", "-o", output, url],
    check=True,
)
print("Download complete (object store direct).")
PY
`;
}
