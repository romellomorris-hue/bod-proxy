// ── Black Owned Detroit — Proxy Server ────────────────────────────────────────
//
//   POST /api/vibe           →  Anthropic AI recommender
//   GET  /api/votes          →  all fire vote counts
//   POST /api/vote/:slug     →  cast / remove a vote
//   GET  /api/leaderboard    →  top 10 most-fired spots
//   POST /api/submit-spot    →  save spot submission to DB
//   GET  /api/submissions    →  view all submissions (admin)
//   GET  /health             →  status + DB check
//
// ── LOCAL SETUP ──────────────────────────────────────────────────────────────
//   1. npm install
//   2. Create .env:  ANTHROPIC_API_KEY=sk-ant-...
//                    DATABASE_URL=postgresql://...
//                    ADMIN_KEY=some-secret-string  (for viewing submissions)
//   3. node proxy-server.js
//
// ── RAILWAY DEPLOY ────────────────────────────────────────────────────────────
//   Push proxy-server.js + package.json to GitHub → Railway auto-redeploys.
//   Set ADMIN_KEY env var in Railway dashboard → Variables.
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
  // Fire votes
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

  // Spot submissions
  await pool.query(`
    CREATE TABLE IF NOT EXISTS spot_submissions (
      id             SERIAL PRIMARY KEY,
      business_name  TEXT NOT NULL,
      category       TEXT,
      neighborhood   TEXT,
      address        TEXT,
      description    TEXT,
      social         TEXT,
      ip_hash        TEXT,
      status         TEXT DEFAULT 'pending',
      created_at     TIMESTAMP DEFAULT NOW()
    );
  `);

  console.log('✅ DB tables ready (votes + submissions)');
}

// ── HELPERS ───────────────────────────────────────────────────────────────────
function hashIP(ip) {
  const day = new Date().toISOString().slice(0, 10);
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

// ── GET /api/leaderboard — top 10 most fired ──────────────────────────────
app.get('/api/leaderboard', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT slug, count FROM spot_votes WHERE count > 0 ORDER BY count DESC LIMIT 10'
    );
    res.json({ leaderboard: result.rows.map(r => ({ slug: r.slug, count: parseInt(r.count) })) });
  } catch (err) {
    console.error('GET /api/leaderboard error:', err.message);
    res.status(500).json({ error: 'Could not fetch leaderboard' });
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
      await pool.query(
        'UPDATE spot_votes SET count = GREATEST(count - 1, 0) WHERE slug = $1', [slug]
      );
      await pool.query(
        'DELETE FROM vote_log WHERE slug = $1 AND ip_hash = $2', [slug, ipHash]
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

// ── POST /api/submit-spot ─────────────────────────────────────────────────
app.post('/api/submit-spot', async (req, res) => {
  const { business_name, category, neighborhood, address, description, social } = req.body;

  // Validate required field
  if (!business_name || business_name.trim().length < 2) {
    return res.status(400).json({ error: 'Business name is required' });
  }

  // Basic sanitize — truncate long inputs
  const clean = (str, max = 200) => (str || '').toString().trim().slice(0, max);

  const ip     = getClientIP(req);
  const ipHash = hashIP(ip);

  try {
    // Rate limit: max 3 submissions per IP per day
    const recent = await pool.query(
      `SELECT COUNT(*) FROM spot_submissions WHERE ip_hash = $1 AND created_at > NOW() - INTERVAL '24 hours'`,
      [ipHash]
    );
    if (parseInt(recent.rows[0].count) >= 3) {
      return res.status(429).json({ error: 'Too many submissions today. Try again tomorrow.' });
    }

    await pool.query(
      `INSERT INTO spot_submissions (business_name, category, neighborhood, address, description, social, ip_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        clean(business_name),
        clean(category, 50),
        clean(neighborhood, 100),
        clean(address, 150),
        clean(description, 500),
        clean(social, 150),
        ipHash
      ]
    );

    console.log(`📍 New submission: ${clean(business_name)} (${clean(category)})`);
    res.json({ ok: true, message: 'Submission received. Thank you!' });

  } catch (err) {
    console.error('POST /api/submit-spot error:', err.message);
    res.status(500).json({ error: 'Submission failed. Try again.' });
  }
});

// ── GET /api/submissions — admin view ─────────────────────────────────────
// Protected by ADMIN_KEY env var. Hit:
// GET /api/submissions?key=your-admin-key
app.get('/api/submissions', async (req, res) => {
  const adminKey = process.env.ADMIN_KEY;
  if (!adminKey || req.query.key !== adminKey) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const result = await pool.query(
      `SELECT id, business_name, category, neighborhood, address, description, social, status, created_at
       FROM spot_submissions ORDER BY created_at DESC`
    );
    res.json({ count: result.rows.length, submissions: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Could not fetch submissions' });
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
      console.log(`   POST /api/vibe            →  Anthropic AI`);
      console.log(`   GET  /api/votes           →  all fire vote counts`);
      console.log(`   POST /api/vote/:slug      →  cast / remove vote`);
      console.log(`   GET  /api/leaderboard     →  top 10 most fired`);
      console.log(`   POST /api/submit-spot     →  save spot submission`);
      console.log(`   GET  /api/submissions     →  admin: view all submissions`);
      console.log(`   GET  /health              →  status + DB check\n`);
    });
  })
  .catch(err => {
    console.error('❌ DB init failed:', err.message);
    app.listen(PORT, () => console.log(`⚠️  BOD proxy running WITHOUT database on port ${PORT}`));
  });