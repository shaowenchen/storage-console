export interface DirectUploadScriptConfig {
  apiBase: string;
  mode: 'storage' | 'project';
  bucketId?: string;
  projectId?: string;
  directoryId?: string;
  relativePath?: string;
}

function shellQuote(value: string): string {
  return `'${String(value || '').replace(/'/g, `'\\''`)}'`;
}

export function directUploadShellScript(config: DirectUploadScriptConfig): string {
  return `set -euo pipefail

API_BASE=${shellQuote(config.apiBase)}
UPLOAD_MODE=${shellQuote(config.mode)}
BUCKET_ID=${shellQuote(config.bucketId || '')}
PROJECT_ID=${shellQuote(config.projectId || '')}
DIRECTORY_ID=${shellQuote(config.directoryId || '')}
RELATIVE_PATH=${shellQuote(config.relativePath || '')}

if [ -z "\${FILE_PATH:-}" ] || [ "$FILE_PATH" = "/path/to/file" ]; then
  echo "Set FILE_PATH to one local file before running this script." >&2
  exit 1
fi
if [ -z "\${STUDIO_UPLOAD_KEY:-}" ]; then
  echo "Set STUDIO_UPLOAD_KEY to your Studio upload key." >&2
  exit 1
fi

python3 - "$API_BASE" "$STUDIO_UPLOAD_KEY" "$UPLOAD_MODE" "$BUCKET_ID" "$PROJECT_ID" "$DIRECTORY_ID" "$RELATIVE_PATH" "$FILE_PATH" <<'PY'
import json
import mimetypes
import os
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request

api_base, token, mode, bucket_id, project_id, directory_id, relative_path, local_path = sys.argv[1:]

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
        fail(f"Studio API failed ({exc.code}): {error}")

if not os.path.isfile(local_path):
    fail(f"Not a file: {local_path}")

content_type = mimetypes.guess_type(local_path)[0] or "application/octet-stream"
file_payload = {
    "name": os.path.basename(local_path),
    "size": os.path.getsize(local_path),
    "contentType": content_type,
}

if mode == "project":
    link_path = f"/projects/{urllib.parse.quote(project_id)}/upload-links"
    link_payload = {"directoryId": directory_id, "files": [file_payload]}
else:
    link_path = f"/storages/{urllib.parse.quote(bucket_id)}/upload-links"
    link_payload = {"relativePath": relative_path, "files": [file_payload]}

link_data = request_json("POST", link_path, link_payload)
uploads = link_data.get("uploads") or []
if len(uploads) != 1:
    fail(f"Expected 1 upload link, got {len(uploads)}")

upload = uploads[0]
content_type = upload.get("contentType") or content_type
print(f"Uploading {local_path} -> {upload.get('key')}")
subprocess.run([
    "curl",
    "--fail",
    "--silent",
    "--show-error",
    "--location",
    "-X",
    "PUT",
    "-H",
    f"Content-Type: {content_type}",
    "--upload-file",
    local_path,
    upload["url"],
], check=True)

completed_file = {
    "key": upload["key"],
    "name": upload.get("name") or os.path.basename(local_path),
    "size": upload.get("size") or os.path.getsize(local_path),
    "contentType": content_type,
    "relativePath": relative_path,
}

if mode == "project":
    complete_path = f"/projects/{urllib.parse.quote(project_id)}/upload-complete"
    complete_payload = {"directoryId": directory_id, "files": [completed_file]}
else:
    complete_path = f"/storages/{urllib.parse.quote(bucket_id)}/upload-complete"
    complete_payload = {"files": [completed_file]}

request_json("POST", complete_path, complete_payload)
print("Upload complete.")
PY
`;
}
