// ── Black Owned Detroit — AI Vibe Proxy Server ────────────────────────────────
// Sits between your HTML and the Anthropic API to handle CORS.
//
// SETUP:
//   1. Install Node.js (nodejs.org) if you don't have it
//   2. In this folder, run:  npm install express cors node-fetch
//   3. Create a .env file with:  ANTHROPIC_API_KEY=sk-ant-...
//   4. Run:  node proxy-server.js
//   5. Open detroit-editorial.html or detroit-street.html in your browser
//
// DEPLOY FREE (so it works online, not just local):
//   - Railway.app: connect GitHub repo, set ANTHROPIC_API_KEY env var, deploy
//   - Render.com: same — free tier works fine for this traffic level
//
// After deploying, replace http://localhost:3001 in both HTML files with
// your deployed URL (e.g. https://bod-proxy.railway.app)
// ─────────────────────────────────────────────────────────────────────────────

const express = require('express');
const cors    = require('cors');
const app     = express();
const PORT    = process.env.PORT || 3001;

// Load .env if present locally
try { require('dotenv').config(); } catch(e) {}

app.use(cors());
app.use(express.json({ limit: '2mb' }));

app.post('/api/vibe', async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set on server' });
  }

  const { messages, system } = req.body;
  if (!messages || !system) {
    return res.status(400).json({ error: 'Missing messages or system prompt' });
  }

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type':         'application/json',
        'x-api-key':            apiKey,
        'anthropic-version':    '2023-06-01',
      },
      body: JSON.stringify({
        model:      'claude-sonnet-4-20250514',
        max_tokens: 1000,
        system,
        messages,
      })
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({ error: data });
    }

    res.json(data);
  } catch (err) {
    console.error('Proxy error:', err);
    res.status(500).json({ error: 'Proxy request failed' });
  }
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.listen(PORT, () => {
  console.log(`\n✅ Black Owned Detroit proxy running on http://localhost:${PORT}`);
  console.log(`   POST /api/vibe  →  Anthropic API`);
  console.log(`   Open your HTML file in a browser to use the AI feature\n`);
});
