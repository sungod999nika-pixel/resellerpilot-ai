const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY =
  process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '';

const ACTIVE_MODEL = 'gemini-3.8-flash';

const MIME_TYPES = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml'
};

function sendJSON(res, status, data) {
  if (res.writableEnded) return;
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

async function generateWithGemini(prompt, systemInstruction) {
  const endpoint =
    `https://generativelanguage.googleapis.com/v1beta/models/${ACTIVE_MODEL}:generateContent`;

  const payload = {
    contents: [{
      role: 'user',
      parts: [{ text: prompt.trim() }]
    }],
    generationConfig: {
      temperature: 0.7,
      maxOutputTokens: 1500
    }
  };

  if (systemInstruction) {
    payload.systemInstruction = {
      parts: [{ text: systemInstruction.trim() }]
    };
  }

  let lastError;

  for (let attempt = 1; attempt <= 2; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 22000);

    try {
      console.log(`Gemini attempt ${attempt} using ${ACTIVE_MODEL}`);

      const apiRes = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': GEMINI_API_KEY
        },
        body: JSON.stringify(payload),
        signal: controller.signal
      });

      const data = await apiRes.json();

      if (apiRes.ok) {
        const text = data.candidates?.[0]?.content?.parts
          ?.map(part => part.text || '')
          .join('')
          .trim();

        if (!text) {
          throw new Error('Gemini returned an empty response.');
        }

        return text;
      }

      const message =
        data.error?.message || `Gemini returned HTTP ${apiRes.status}`;

      const temporaryError =
        apiRes.status === 429 ||
        apiRes.status === 500 ||
        apiRes.status === 502 ||
        apiRes.status === 503 ||
        apiRes.status === 504;

      if (!temporaryError) {
        const error = new Error(message);
        error.status = apiRes.status;
        throw error;
      }

      lastError = new Error(message);

    } catch (err) {
      lastError = err;

      if (err.status) throw err;

      console.error(`Gemini attempt ${attempt} failed:`, err.message);
    } finally {
      clearTimeout(timeout);
    }

    if (attempt < 2) {
      await new Promise(resolve => setTimeout(resolve, 1500));
    }
  }

  throw lastError || new Error('Gemini could not complete the request.');
}

const server = http.createServer(async (req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (pathname === '/api/health' && req.method === 'GET') {
    return sendJSON(res, 200, {
      status: GEMINI_API_KEY ? 'ready' : 'missing_api_key',
      model: ACTIVE_MODEL,
      timestamp: new Date().toISOString()
    });
  }

  if (pathname === '/api/generate' && req.method === 'POST') {
    if (!GEMINI_API_KEY) {
      return sendJSON(res, 500, {
        success: false,
        error: 'Gemini API key is missing from server settings.'
      });
    }

    try {
      let body = '';

      for await (const chunk of req) {
        body += chunk;

        if (body.length > 100000) {
          return sendJSON(res, 413, {
            success: false,
            error: 'Request is too large.'
          });
        }
      }

      const { prompt, systemInstruction } = JSON.parse(body || '{}');

      if (!prompt || typeof prompt !== 'string') {
        return sendJSON(res, 400, {
          success: false,
          error: 'A valid text prompt is required.'
        });
      }

      if (
        systemInstruction !== undefined &&
        typeof systemInstruction !== 'string'
      ) {
        return sendJSON(res, 400, {
          success: false,
          error: 'Invalid system instruction.'
        });
      }

      const text = await generateWithGemini(prompt, systemInstruction);

      console.log('Gemini generation successful.');

      return sendJSON(res, 200, {
        success: true,
        model: ACTIVE_MODEL,
        text
      });

    } catch (err) {
      console.error('Generation error:', err.message);

      const status = err.status || (
        err.name === 'AbortError' ? 504 : 502
      );

      return sendJSON(res, status, {
        success: false,
        error: err.name === 'AbortError'
          ? 'Gemini took too long to respond. Please try again.'
          : err.message || 'AI generation failed.'
      });
    }
  }

  const safePath = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const filePath = path.resolve(__dirname, 'public', safePath);
  const publicDir = path.resolve(__dirname, 'public');

  if (!filePath.startsWith(publicDir + path.sep) && filePath !== publicDir) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, content) => {
    if (err) {
      fs.readFile(path.join(publicDir, 'index.html'), (fallbackErr, fallback) => {
        if (fallbackErr) {
          res.writeHead(404);
          res.end('Not found');
        } else {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(fallback);
        }
      });
      return;
    }

    const ext = path.extname(filePath);
    res.writeHead(200, {
      'Content-Type': MIME_TYPES[ext] || 'application/octet-stream'
    });
    res.end(content);
  });
});

server.listen(PORT, () => {
  console.log(
    `[ResellerPilot AI] Server running on port ${PORT} with model ${ACTIVE_MODEL}`
  );
});
