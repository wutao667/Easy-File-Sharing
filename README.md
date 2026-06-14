# Easy File Sharing — Simple File Sharing & MCP Server

Easy File Sharing is a password-protected file sharing server with both a web UI and an MCP (Model Context Protocol) interface for AI agents.

## Features

### Web File Sharing
- Password-protected upload/download/delete
- **Share links** — click 🔗 to generate a unique public download URL for each file, no login required
- **Change password** UI — update your password from the web interface at any time
- **Default password detection** — first-run auto-creates `server/password.json` with default password `123456`, shows a banner and redirects to change password
- Drag-and-drop file upload with progress bar, 500MB per-file limit
- Session-based authentication (24h expiry)
- Mobile-responsive layout

### Password Store
- Password stored as bcrypt hash in `server/password.json`
- Web UI and MCP server share the same password file
- Modify password once, both update automatically

### MCP Server (for AI Agents)
- **5 MCP tools**: list_files, upload_file, download_file, delete_file, get_file_info
- Streamable HTTP + SSE transport modes
- Uses the same password as the web UI

## Screenshot

![File sharing dashboard](screenshot.png)

## Quick Start

### Prerequisites
- Node.js 18+
- A Unix-like system

### Install
```bash
git clone https://github.com/wutao667/Easy-File-Sharing.git
cd Easy-File-Sharing/server
npm install
```

### Run
```bash
npm start          # Web UI on port 3100
npm run start:mcp  # MCP server on port 3101
```

> No configuration needed. First run auto-creates `server/password.json` with default password `123456`. Change it from the web UI.

## Web UI

Open `http://localhost:3100` — login with password, then drag & drop to upload.

### Share Links
Each file in the list has a 🔗 button. Click it to generate a unique share URL and copy it to clipboard. Anyone with this URL can download the file without logging in.

```
https://files.huaguo.site/s/a1b2c3d4e5f6...
```

### Change Password
Click "Change Password" in the header. Enter your old password and a new one (min 4 characters). The same password is used for both the web UI and MCP access.

## MCP API

### Authentication
Use the current web UI password as the MCP API key:

```bash
x-api-key: <your-password>
```

### Streamable HTTP
```bash
# Initialize session
curl -X POST http://localhost:3101/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "x-api-key: <password>" \
  -d '{"jsonrpc":"2.0","method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"agent","version":"1.0"}},"id":1}'

# List files (use session-id from initialize)
curl -X POST http://localhost:3101/mcp \
  -H "Content-Type: application/json" \
  -H "mcp-session-id: <session-id>" \
  -H "x-api-key: <password>" \
  -d '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"list_files","arguments":{}},"id":2}'
```

### MCP Tools
| Tool | Description |
|------|-------------|
| list_files | List all uploaded files |
| upload_file | Upload file from base64 content |
| download_file | Download file as base64 |
| delete_file | Delete a file |
| get_file_info | Get file metadata |

## Project Structure
```
.
├── index.html              # Static download landing page
├── screenshot.png          # Dashboard UI screenshot
├── server/
│   ├── package.json            # Node.js dependencies and scripts
│   ├── package-lock.json       # Locked dependency versions
│   ├── server.js              # Express web server (port 3100)
│   ├── files-mcp-server.js    # MCP server (port 3101)
│   ├── password-store.js      # Shared bcrypt password module
│   ├── password.json          # Password hash file (gitignored)
│   ├── share-links.json       # Share link tokens (gitignored)
│   ├── .gitignore              # Ignores password.json, share-links.json
│   └── files-mcp-server.service  # Systemd unit file for MCP server
├── skill/
│   └── SKILL.md               # OpenClaw agent skill
├── uploads/                   # Uploaded files (gitignored)
└── .gitignore                  # Ignores node_modules/, uploads/, .env
```

## Tech Stack
Node.js, Express.js, @modelcontextprotocol/sdk, multer, bcryptjs

## License
MIT
