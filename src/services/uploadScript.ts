export interface DirectUploadScriptConfig {
  apiBase: string;
  bucketId: string;
  relativePath?: string;
}

function shellQuote(value: string): string {
  return `'${String(value || '').replace(/'/g, `'\\''`)}'`;
}

/**
 * Bash+Python CLI that mints a presigned PUT URL then uploads the file
 * directly to the object store (same pattern as getagents).
 */
export function directUploadShellScript(config: DirectUploadScriptConfig): string {
  return `set -euo pipefail

API_BASE=${shellQuote(config.apiBase)}
BUCKET_ID=${shellQuote(config.bucketId)}
RELATIVE_PATH=${shellQuote(config.relativePath || '')}

if [ -z "\${FILE_PATH:-}" ] || [ "$FILE_PATH" = "/path/to/file" ]; then
  echo "Set FILE_PATH to one local file before running this script." >&2
  exit 1
fi

UPLOAD_KEY="\${STORAGE_CONSOLE_UPLOAD_KEY:-\${STUDIO_UPLOAD_KEY:-}}"
if [ -z "$UPLOAD_KEY" ]; then
  echo "Set STORAGE_CONSOLE_UPLOAD_KEY to your upload API key." >&2
  exit 1
fi

python3 - "$API_BASE" "$UPLOAD_KEY" "$BUCKET_ID" "$RELATIVE_PATH" "$FILE_PATH" <<'PY'
import json
import mimetypes
import os
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request

api_base, token, bucket_id, relative_path, local_path = sys.argv[1:]

def fail(message):
    print(message, file=sys.stderr)
    sys.exit(1)

def request_json(method, path, payload):
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        api_base + path,
        data=data,
        method=method,
        headers={"Content-Type": "application/json", "X-API-Key": token},
    )
    try:
        with urllib.request.urlopen(req) as response:
            return json.loads(response.read().decode("utf-8") or "{}")
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", "replace")
        try:
            error = json.loads(body).get("error") or body
        except json.JSONDecodeError:
            error = body
        fail(f"API failed ({exc.code}): {error}")

if not os.path.isfile(local_path):
    fail(f"Not a file: {local_path}")

content_type = mimetypes.guess_type(local_path)[0] or "application/octet-stream"
file_payload = {
    "name": os.path.basename(local_path),
    "size": os.path.getsize(local_path),
    "contentType": content_type,
}

link_path = f"/storages/{urllib.parse.quote(bucket_id)}/upload-links"
link_data = request_json("POST", link_path, {"relativePath": relative_path, "files": [file_payload]})
uploads = link_data.get("uploads") or []
if len(uploads) != 1:
    fail(f"Expected 1 upload link, got {len(uploads)}")

upload = uploads[0]
content_type = upload.get("contentType") or content_type
headers = upload.get("headers") or {}
print(f"Direct upload {local_path} -> {upload.get('key')}")
curl_cmd = [
    "curl",
    "--fail",
    "--silent",
    "--show-error",
    "--location",
    "-X",
    "PUT",
    "--upload-file",
    local_path,
    upload["url"],
]
for header_name, header_value in headers.items():
    curl_cmd.extend(["-H", f"{header_name}: {header_value}"])
if "Content-Type" not in headers and "content-type" not in {k.lower() for k in headers}:
    curl_cmd.extend(["-H", f"Content-Type: {content_type}"])
subprocess.run(curl_cmd, check=True)

request_json(
    "POST",
    f"/storages/{urllib.parse.quote(bucket_id)}/upload-complete",
    {
        "files": [{
            "key": upload["key"],
            "name": upload.get("name") or os.path.basename(local_path),
            "size": upload.get("size") or os.path.getsize(local_path),
            "contentType": content_type,
            "relativePath": relative_path,
        }]
    },
)
print("Upload complete (object store direct).")
PY
`;
}
