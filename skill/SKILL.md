---
name: files-huaguo-site
description: Use this skill when an OpenClaw agent needs to list, upload, download, inspect, or delete files in the files.huaguo.site file sharing service through MCP.
---

# files.huaguo.site MCP Skill

Use the MCP server to interact with the private file sharing service at `files.huaguo.site`.

## Connection

Preferred endpoint for current MCP clients:

```json
{
  "url": "https://files.huaguo.site/mcp",
  "transport": "streamable_http",
  "headers": {
    "x-api-key": "<FILE_PASSWORD>"
  }
}
```

Legacy HTTP+SSE clients can connect to:

```json
{
  "sse_url": "https://files.huaguo.site/sse",
  "message_url": "https://files.huaguo.site/messages",
  "headers": {
    "x-api-key": "<FILE_PASSWORD>"
  }
}
```

The local MCP process listens on `127.0.0.1:3101`. Public remote access should go through the reverse proxy.

## Authentication

Every MCP request must include one of these headers:

```http
x-api-key: <FILE_PASSWORD>
Authorization: Bearer <FILE_PASSWORD>
```

The API key is the service password configured by `FILES_MCP_API_KEY` or `FILE_PASSWORD`. If neither is set, the fallback key is `123456`.

## Tools

### `list_files`

List all uploaded files, newest first.

Parameters: none.

Example:

```json
{}
```

Returns:

```json
{
  "files": [
    {
      "name": "report.pdf",
      "size": 12345,
      "mtime": "2026-06-14T09:31:00.000Z",
      "icon": "pdf",
      "downloadUrl": "https://files.huaguo.site/d/report.pdf"
    }
  ]
}
```

### `upload_file`

Upload a file from base64 content.

Parameters:

```json
{
  "name": "hello.txt",
  "content_base64": "SGVsbG8K",
  "overwrite": false
}
```

Rules:

- `name` must be a file name only, without `/`, `\`, absolute paths, or `..`.
- `content_base64` is the complete file content encoded as base64.
- `overwrite` defaults to `false`; duplicate names receive a timestamp suffix.
- Maximum file size defaults to 500 MB.

Returns uploaded file metadata.

### `download_file`

Download a file and return base64 content.

Parameters:

```json
{
  "name": "hello.txt"
}
```

Returns:

```json
{
  "name": "hello.txt",
  "size": 6,
  "mtime": "2026-06-14T09:31:00.000Z",
  "icon": "text",
  "downloadUrl": "https://files.huaguo.site/d/hello.txt",
  "content_base64": "SGVsbG8K"
}
```

Decode `content_base64` to recover the original bytes.

### `delete_file`

Delete a file by name.

Parameters:

```json
{
  "name": "hello.txt"
}
```

Returns:

```json
{
  "ok": true,
  "deleted": {
    "name": "hello.txt",
    "size": 6,
    "mtime": "2026-06-14T09:31:00.000Z",
    "icon": "text",
    "downloadUrl": "https://files.huaguo.site/d/hello.txt"
  }
}
```

### `get_file_info`

Fetch metadata for one file without downloading content.

Parameters:

```json
{
  "name": "report.pdf"
}
```

Returns:

```json
{
  "file": {
    "name": "report.pdf",
    "size": 12345,
    "mtime": "2026-06-14T09:31:00.000Z",
    "icon": "pdf",
    "downloadUrl": "https://files.huaguo.site/d/report.pdf"
  }
}
```

## Agent Workflow

1. Call `list_files` before uploading if duplicate names matter.
2. Use `upload_file` with `overwrite: false` unless the user explicitly wants replacement.
3. Use `get_file_info` before delete operations when confirming target identity.
4. Treat `download_file` output as base64; do not display large base64 blobs to users unless requested.
