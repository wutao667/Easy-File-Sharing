const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const passwordStore = require('./password-store');

const mcpSdkDir = path.resolve(__dirname, 'node_modules/@modelcontextprotocol/sdk/dist/cjs');
const { McpServer } = require(path.join(mcpSdkDir, 'server/mcp.js'));
const { StreamableHTTPServerTransport } = require(path.join(mcpSdkDir, 'server/streamableHttp.js'));
const { SSEServerTransport } = require(path.join(mcpSdkDir, 'server/sse.js'));
const { createMcpExpressApp } = require(path.join(mcpSdkDir, 'server/express.js'));
const { isInitializeRequest } = require(path.join(mcpSdkDir, 'types.js'));
const z = require('zod');

const PORT = Number(process.env.FILES_MCP_PORT || 3101);
const HOST = process.env.FILES_MCP_HOST || '127.0.0.1';
const UPLOAD_DIR = path.resolve(__dirname, '../uploads');
const MAX_FILE_SIZE = Number(process.env.FILES_MCP_MAX_FILE_SIZE || 500 * 1024 * 1024);

fs.mkdirSync(UPLOAD_DIR, { recursive: true });
passwordStore.init();

function assertApiKey(req, res, next) {
  const bearer = req.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
  const provided = req.headers['x-api-key'] || bearer;

  if (provided && passwordStore.verify(provided)) return next();

  res.status(401).json({
    jsonrpc: '2.0',
    error: { code: -32001, message: 'Unauthorized: missing or invalid API key' },
    id: null
  });
}

function safePath(name) {
  if (!name || typeof name !== 'string') {
    throw new Error('filename is required');
  }

  const normalized = path.normalize(name);
  if (path.isAbsolute(normalized) || normalized.includes('..') || normalized.includes(path.sep)) {
    throw new Error('invalid filename');
  }

  const filePath = path.resolve(UPLOAD_DIR, normalized);
  const root = UPLOAD_DIR.endsWith(path.sep) ? UPLOAD_DIR : UPLOAD_DIR + path.sep;
  if (!filePath.startsWith(root)) {
    throw new Error('invalid filename');
  }

  return filePath;
}

function getFileIcon(name) {
  const ext = path.extname(name).toLowerCase();
  const icons = {
    '.jpg': 'image', '.jpeg': 'image', '.png': 'image', '.gif': 'image', '.webp': 'image', '.svg': 'image',
    '.mp4': 'video', '.mov': 'video', '.avi': 'video', '.mkv': 'video',
    '.mp3': 'audio', '.wav': 'audio', '.flac': 'audio',
    '.pdf': 'pdf', '.doc': 'document', '.docx': 'document', '.xls': 'spreadsheet', '.xlsx': 'spreadsheet',
    '.ppt': 'presentation', '.pptx': 'presentation',
    '.zip': 'archive', '.rar': 'archive', '.7z': 'archive', '.tar': 'archive', '.gz': 'archive',
    '.apk': 'mobile-app', '.ipa': 'mobile-app',
    '.js': 'code', '.py': 'code', '.go': 'code', '.rs': 'code', '.ts': 'code',
    '.txt': 'text', '.md': 'markdown', '.json': 'json', '.yaml': 'yaml', '.yml': 'yaml',
    '.html': 'html', '.css': 'css'
  };
  return icons[ext] || 'file';
}

function fileInfo(name) {
  const filePath = safePath(name);
  if (!fs.existsSync(filePath)) {
    throw new Error(`file not found: ${name}`);
  }

  const stat = fs.statSync(filePath);
  if (!stat.isFile()) {
    throw new Error(`not a file: ${name}`);
  }

  return {
    name,
    size: stat.size,
    mtime: stat.mtime.toISOString(),
    icon: getFileIcon(name),
    downloadUrl: `https://files.huaguo.site/d/${encodeURIComponent(name)}`
  };
}

function listFiles() {
  return fs.readdirSync(UPLOAD_DIR)
    .filter(name => name !== '.gitkeep')
    .map(name => {
      try {
        return fileInfo(name);
      } catch (_err) {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => new Date(b.mtime) - new Date(a.mtime));
}

function jsonToolResult(value) {
  return {
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }]
  };
}

function createServer() {
  const server = new McpServer({
    name: 'files-huaguo-site',
    version: '1.0.0'
  });

  server.registerTool('list_files', {
    title: 'List files',
    description: 'List uploaded files with name, size, mtime, icon, and download URL.',
    inputSchema: {}
  }, async () => jsonToolResult({ files: listFiles() }));

  server.registerTool('upload_file', {
    title: 'Upload file',
    description: 'Upload a file from base64 content. If overwrite is false, duplicate names get a timestamp suffix.',
    inputSchema: {
      name: z.string().min(1).describe('File name only, without path separators.'),
      content_base64: z.string().min(1).describe('Base64-encoded file content.'),
      overwrite: z.boolean().default(false).describe('Replace an existing file with the same name.')
    }
  }, async ({ name, content_base64, overwrite }) => {
    let data;
    try {
      data = Buffer.from(content_base64, 'base64');
    } catch (_err) {
      throw new Error('content_base64 is not valid base64');
    }

    if (data.length > MAX_FILE_SIZE) {
      throw new Error(`file too large: max ${MAX_FILE_SIZE} bytes`);
    }

    let targetName = name;
    let targetPath = safePath(targetName);

    if (!overwrite && fs.existsSync(targetPath)) {
      const ext = path.extname(name);
      const base = path.basename(name, ext);
      targetName = `${base}_${Date.now()}${ext}`;
      targetPath = safePath(targetName);
    }

    fs.writeFileSync(targetPath, data, { flag: overwrite ? 'w' : 'wx' });
    return jsonToolResult({ ok: true, file: fileInfo(targetName) });
  });

  server.registerTool('download_file', {
    title: 'Download file',
    description: 'Download a file and return its base64 content.',
    inputSchema: {
      name: z.string().min(1).describe('File name to download.')
    }
  }, async ({ name }) => {
    const info = fileInfo(name);
    const content = fs.readFileSync(safePath(name)).toString('base64');
    return jsonToolResult({ ...info, content_base64: content });
  });

  server.registerTool('delete_file', {
    title: 'Delete file',
    description: 'Delete one uploaded file by name.',
    inputSchema: {
      name: z.string().min(1).describe('File name to delete.')
    }
  }, async ({ name }) => {
    const info = fileInfo(name);
    fs.unlinkSync(safePath(name));
    return jsonToolResult({ ok: true, deleted: info });
  });

  server.registerTool('get_file_info', {
    title: 'Get file info',
    description: 'Get metadata for one uploaded file.',
    inputSchema: {
      name: z.string().min(1).describe('File name to inspect.')
    }
  }, async ({ name }) => jsonToolResult({ file: fileInfo(name) }));

  return server;
}

const app = createMcpExpressApp({
  host: HOST,
  allowedHosts: ['files.huaguo.site', 'localhost', '127.0.0.1', '[::1]']
});
const transports = {};

app.use(assertApiKey);

app.all('/mcp', async (req, res) => {
  try {
    const sessionId = req.headers['mcp-session-id'];
    let transport;

    if (sessionId && transports[sessionId] instanceof StreamableHTTPServerTransport) {
      transport = transports[sessionId];
    } else if (!sessionId && req.method === 'POST' && isInitializeRequest(req.body)) {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
        onsessioninitialized: id => {
          transports[id] = transport;
        }
      });

      transport.onclose = () => {
        if (transport.sessionId) delete transports[transport.sessionId];
      };

      await createServer().connect(transport);
    } else {
      res.status(400).json({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Bad Request: no valid MCP session' },
        id: null
      });
      return;
    }

    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error('MCP request failed:', err);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: { code: -32603, message: 'Internal server error' },
        id: null
      });
    }
  }
});

app.get('/sse', async (_req, res) => {
  const transport = new SSEServerTransport('/messages', res);
  transports[transport.sessionId] = transport;
  res.on('close', () => delete transports[transport.sessionId]);
  await createServer().connect(transport);
});

app.post('/messages', async (req, res) => {
  const sessionId = req.query.sessionId;
  const transport = transports[sessionId];

  if (!(transport instanceof SSEServerTransport)) {
    res.status(400).send('No SSE transport found for sessionId');
    return;
  }

  await transport.handlePostMessage(req, res, req.body);
});

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'files-mcp-server' });
});

const httpServer = app.listen(PORT, HOST, error => {
  if (error) {
    console.error('Failed to start files MCP server:', error);
    process.exit(1);
  }

});

async function shutdown() {
  for (const id of Object.keys(transports)) {
    try {
      await transports[id].close();
    } catch (err) {
      console.error(`Failed to close transport ${id}:`, err);
    }
    delete transports[id];
  }
  httpServer.close(() => process.exit(0));
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
