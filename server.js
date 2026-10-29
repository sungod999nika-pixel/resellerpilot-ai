const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '';
const ACTIVE_MODEL = 'gemini-3.8-flash';

const MIME_TYPES = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml'
};

const server = http.createServer(async (req, res) => {
  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // 1. Health check
  if (pathname === '/api/health' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: GEMINI_API_KEY ? 'ready' : 'missing_api_key',
      model: ACTIVE_MODEL,
      timestamp: new Date().toISOString()
    }));
    return;
  }

  // 2. Generation endpoint
  if (pathname === '/api/generate' && req.method === 'POST') {
    if (!GEMINI_API_KEY) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: false,
        error: 'GEMINI_API_KEY environment variable is not configured on the server.'
      }));
      return;
    }

    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const { prompt, systemInstruction } = JSON.parse(body || '{}');

        if (!prompt || typeof prompt !== 'string') {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'A valid text prompt is required.' }));
          return;
        }

        const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${ACTIVE_MODEL}:generateContent`;
        const payload = {
          contents: [{ role: 'user', parts: [{ text: prompt.trim() }] }],
          generationConfig: { temperature: 0.7, maxOutputTokens: 1500 }
        };
        if (systemInstruction) {
          payload.systemInstruction = { parts: [{ text: systemInstruction.trim() }] };
        }

        const apiRes = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': GEMINI_API_KEY
          },
          body: JSON.stringify(payload)
        });

        const data = await apiRes.json();

        if (!apiRes.ok) {
          const errMsg = data.error?.message || `Gemini API returned HTTP ${apiRes.status}`;
          res.writeHead(apiRes.status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: errMsg }));
          return;
        }

        const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!text) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'Empty text returned by model.' }));
          return;
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, model: ACTIVE_MODEL, text }));

      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err.message || 'Internal server error' }));
      }
    });
    return;
  }

  // 3. Static file serving (public/index.html)
  let filePath = path.join(__dirname, 'public', pathname === '/' ? 'index.html' : pathname);
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    filePath = path.join(__dirname, 'public', 'index.html');
  }

  const ext = path.extname(filePath);
  const contentType = MIME_TYPES[ext] || 'text/html';

  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(500);
      res.end('File read error');
    } else {
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(content);
    }
  });
});

server.listen(PORT, () => {
  console.log(`[ResellerPilot AI] Server running on port ${PORT} with model ${ACTIVE_MODEL}`);
});
