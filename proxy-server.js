// ── Black Owned Detroit — Proxy Server ────────────────────────────────────────
//
// Handles two things:
//   1. AI Vibe Recommender  →  POST /api/vibe     (Anthropic API proxy)
//   2. Community Fire Votes →  GET  /api/votes    (all vote counts)
//                              POST /api/vote/:slug (cast/remove a vote)
//
// ── LOCAL SETUP ──────────────────────────────────────────────────────────────
//   1. npm install
//   2. Create a .env file:
//        ANTHROPIC_API_KEY=sk-ant-...
//        DATABASE_URL=postgresql://user:pass@host:5432/dbname
//   3. node proxy-server.js
//
// ── RAILWAY DEPLOY ────────────────────────────────────────────────────────────
//   1. Push this file + package.json to your GitHub repo
//   2. In Railway dashboard → your existing "bod-proxy" service → redeploy
//   3. In Railway dashboard → New → Database → PostgreSQL
//      Railway will auto-set DATABASE_URL in your service env vars
//   4. That's it — DB schema is created automatically on first start
// ─────────────────────────────────────────────────────────────────────────────

const express  = require('express');
const cors     = require('cors');
const { Pool } = require('pg');
const crypto   = require('crypto');
const app      = express();
const PORT     = process.env.PORT || 3001;

try { require('dotenv').config(); } catch(e) {}

app.use(cors());
app.use(express.json({ limit: '2mb' }));

// ── POSTGRES ──────────────────────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('railway') || process.env.NODE_ENV === 'production'
    ? { rejectUnauthorized: false }
    : false
});

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS spot_votes (
      slug    TEXT PRIMARY KEY,
      count   INTEGER NOT NULL DEFAULT 0
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS vote_log (
      id         SERIAL PRIMARY KEY,
      slug       TEXT NOT NULL,
      ip_hash    TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(slug, ip_hash)
    );
  `);
  console.log('✅ DB tables ready');
}

// One-way IP hash — rotates daily so no permanent tracking
function hashIP(ip) {
  const day = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  return crypto.createHash('sha256')
    .update(ip + day + 'bod-salt-313')
    .digest('hex').slice(0, 16);
}

function getClientIP(req) {
  return (
    req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
    req.headers['x-real-ip'] ||
    req.socket?.remoteAddress ||
    'unknown'
  );
}

// ── GET /api/votes ─────────────────────────────────────────────────────────
app.get('/api/votes', async (req, res) => {
  try {
    const result = await pool.query('SELECT slug, count FROM spot_votes ORDER BY count DESC');
    const votes = {};
    result.rows.forEach(row => { votes[row.slug] = parseInt(row.count); });
    res.json({ votes });
  } catch (err) {
    console.error('GET /api/votes error:', err.message);
    res.status(500).json({ error: 'Could not fetch votes' });
  }
});

// ── POST /api/vote/:slug ───────────────────────────────────────────────────
app.post('/api/vote/:slug', async (req, res) => {
  const { slug } = req.params;
  if (!slug || slug.length > 120) return res.status(400).json({ error: 'Invalid slug' });

  const ip     = getClientIP(req);
  const ipHash = hashIP(ip);

  try {
    const existing = await pool.query(
      'SELECT id FROM vote_log WHERE slug = $1 AND ip_hash = $2',
      [slug, ipHash]
    );

    let action;

    if (existing.rows.length === 0) {
      // Cast vote
      await pool.query(`
        INSERT INTO spot_votes (slug, count) VALUES ($1, 1)
        ON CONFLICT (slug) DO UPDATE SET count = spot_votes.count + 1
      `, [slug]);
      await pool.query(
        'INSERT INTO vote_log (slug, ip_hash) VALUES ($1, $2)',
        [slug, ipHash]
      );
      action = 'fired';
    } else {
      // Remove vote
      await pool.query(`
        UPDATE spot_votes SET count = GREATEST(count - 1, 0) WHERE slug = $1
      `, [slug]);
      await pool.query(
        'DELETE FROM vote_log WHERE slug = $1 AND ip_hash = $2',
        [slug, ipHash]
      );
      action = 'unfired';
    }

    const countResult = await pool.query('SELECT count FROM spot_votes WHERE slug = $1', [slug]);
    const count = parseInt(countResult.rows[0]?.count ?? 0);
    res.json({ action, slug, count });

  } catch (err) {
    console.error('POST /api/vote error:', err.message);
    res.status(500).json({ error: 'Vote failed' });
  }
});

// ── POST /api/vibe — Anthropic proxy ──────────────────────────────────────
app.post('/api/vibe', async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set' });

  const { messages, system } = req.body;
  if (!messages || !system) return res.status(400).json({ error: 'Missing messages or system' });

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model:      'claude-sonnet-4-20250514',
        max_tokens: 1000,
        system,
        messages,
      })
    });
    const data = await response.json();
    if (!response.ok) return res.status(response.status).json({ error: data });
    res.json(data);
  } catch (err) {
    console.error('Vibe proxy error:', err);
    res.status(500).json({ error: 'Proxy request failed' });
  }
});

// ── HEALTH ────────────────────────────────────────────────────────────────────
app.get('/health', async (req, res) => {
  let dbOk = false;
  try { await pool.query('SELECT 1'); dbOk = true; } catch(e) {}
  res.json({ status: 'ok', db: dbOk ? 'connected' : 'error' });
});

// ── START ─────────────────────────────────────────────────────────────────────
initDB()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`\n✅ BOD proxy running on http://localhost:${PORT}`);
      console.log(`   POST /api/vibe       →  Anthropic AI`);
      console.log(`   GET  /api/votes      →  all vote counts`);
      console.log(`   POST /api/vote/:slug →  cast / remove vote`);
      console.log(`   GET  /health         →  status + DB check\n`);
    });
  })
  .catch(err => {
    console.error('❌ DB init failed:', err.message);
    // Start anyway so the AI vibe feature still works without DB
    app.listen(PORT, () => console.log(`⚠️  BOD proxy running WITHOUT database on port ${PORT}`));
  });