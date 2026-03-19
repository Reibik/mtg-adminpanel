require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const path    = require('path');
const bcrypt  = require('bcryptjs');
const db      = require('./db');
const ssh     = require('./ssh');
const authenticator = require('./totp');
const clientRoutes = require('./routes/client');
const adminExtraRoutes = require('./routes/admin-extra');

// ── Config ────────────────────────────────────────────────
const AUTH_TOKEN = process.env.AUTH_TOKEN || 'changeme';
const PORT       = process.env.PORT || 3000;

// Version: /app/src/app.js → ../package.json = /app/package.json = backend/package.json in Docker
let pkgVersion = 'unknown';
try { pkgVersion = require('../package.json').version; } catch (_) {}

// ── DB Migrations ─────────────────────────────────────────
function runMigrations() {
  const migrations = [
    "ALTER TABLE nodes ADD COLUMN flag TEXT DEFAULT NULL",
    "ALTER TABLE nodes ADD COLUMN agent_port INTEGER DEFAULT NULL",
    "ALTER TABLE users ADD COLUMN traffic_rx_snap TEXT DEFAULT NULL",
    "ALTER TABLE users ADD COLUMN traffic_tx_snap TEXT DEFAULT NULL",
    "ALTER TABLE users ADD COLUMN traffic_reset_at DATETIME DEFAULT NULL",
    "ALTER TABLE users ADD COLUMN last_seen_at DATETIME DEFAULT NULL",
    "ALTER TABLE users ADD COLUMN billing_price REAL DEFAULT NULL",
    "ALTER TABLE users ADD COLUMN billing_currency TEXT DEFAULT 'RUB'",
    "ALTER TABLE users ADD COLUMN billing_period TEXT DEFAULT 'monthly'",
    "ALTER TABLE users ADD COLUMN billing_paid_until DATETIME DEFAULT NULL",
    "ALTER TABLE users ADD COLUMN billing_status TEXT DEFAULT 'active'",
    // v1.7.0 — device limits & auto traffic reset
    "ALTER TABLE users ADD COLUMN max_devices INTEGER DEFAULT NULL",
    "ALTER TABLE users ADD COLUMN traffic_reset_interval TEXT DEFAULT NULL",
    "ALTER TABLE users ADD COLUMN next_reset_at DATETIME DEFAULT NULL",
    "ALTER TABLE users ADD COLUMN total_traffic_rx_bytes INTEGER DEFAULT 0",
    "ALTER TABLE users ADD COLUMN total_traffic_tx_bytes INTEGER DEFAULT 0",
  ];
  for (const sql of migrations) {
    try { db.prepare(sql).run(); } catch (_) {}
  }
}
runMigrations();

// ── App ───────────────────────────────────────────────────
const app = express();
app.set('trust proxy', true);
app.use(cors());
app.use(express.json());

// Admin panel static files — only under /admin
app.use('/admin', express.static(path.join(__dirname, '../public')));

// Client SPA static files (built React app)
const clientDistPath = path.join(__dirname, '../public-client');
app.use(express.static(clientDistPath));

// ── Git commit hash ───────────────────────────────────────
let gitCommit = null;
try {
  const { execFileSync } = require('child_process');
  gitCommit = execFileSync('git', ['-C', '/repo', 'rev-parse', '--short', 'HEAD'], { timeout: 5000 }).toString().trim();
} catch (_) {}

// ── Public endpoints (no auth) ────────────────────────────
app.get('/api/version', (req, res) => {
  res.json({ version: pkgVersion, commit: gitCommit });
});

// ── Check for updates (panel + agent from GitHub) ─────────
const https = require('https');
function githubGet(path) {
  return new Promise((resolve, reject) => {
    const req = https.get({
      hostname: 'api.github.com',
      path,
      headers: { 'User-Agent': 'stvillage-proxy', 'Accept': 'application/vnd.github.v3+json' },
      timeout: 10000
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { resolve(null); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

app.get('/api/check-updates', async (req, res) => {
  try {
    const [release, agentPkg] = await Promise.allSettled([
      githubGet('/repos/Reibik/mtg-adminpanel/releases/latest'),
      githubGet('/repos/Reibik/mtg-adminpanel/contents/mtg-agent/main.py?ref=main'),
    ]);

    const latest = release.status === 'fulfilled' ? release.value : null;
    const latestTag = latest?.tag_name?.replace(/^v/, '') || null;
    const currentVersion = pkgVersion.replace(/^v/, '');

    // Parse agent version from main.py content (base64)
    let agentVersion = null;
    if (agentPkg.status === 'fulfilled' && agentPkg.value?.content) {
      const content = Buffer.from(agentPkg.value.content, 'base64').toString();
      const match = content.match(/version="([^"]+)"/);
      if (match) agentVersion = match[1];
    }

    res.json({
      panel: {
        current: currentVersion,
        latest: latestTag,
        hasUpdate: latestTag ? latestTag !== currentVersion : false,
        releaseUrl: latest?.html_url || null,
        releaseNotes: latest?.body || null,
        publishedAt: latest?.published_at || null,
      },
      agent: {
        latest: agentVersion,
      },
    });
  } catch (e) {
    res.status(500).json({ error: 'Failed to check updates', details: e.message });
  }
});

// ── Client routes (JWT auth, no admin token) ──────────────
app.use('/api/client', clientRoutes);
// YooKassa webhook (IP-verified, no auth)
app.use('/api', clientRoutes);

// ── Admin user login (returns token + role) ───────────────
app.post('/api/admin/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Логин и пароль обязательны' });
  const user = db.prepare('SELECT * FROM admin_users WHERE username = ? AND status = ?').get(username, 'active');
  if (!user) return res.status(401).json({ error: 'Неверный логин или пароль' });
  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) return res.status(401).json({ error: 'Неверный логин или пароль' });
  db.prepare("UPDATE admin_users SET last_login_at = datetime('now') WHERE id = ?").run(user.id);
  const sessionToken = createAdminSessionToken(username, user.role);
  res.json({ role: user.role, display_name: user.display_name || user.username, sessionToken });
});

// ── Admin session tokens (HMAC-signed) ────────────────────
const crypto = require('crypto');
const ADMIN_SESSION_SECRET = (process.env.JWT_SECRET || AUTH_TOKEN) + ':admin-session';
const adminSessions = new Map(); // token -> { username, role, createdAt }

function createAdminSessionToken(username, role) {
  const payload = `${username}:${role}:${Date.now()}`;
  const hmac = crypto.createHmac('sha256', ADMIN_SESSION_SECRET).update(payload).digest('hex');
  const token = `session:${Buffer.from(payload).toString('base64')}.${hmac}`;
  adminSessions.set(token, { username, role, createdAt: Date.now() });
  return token;
}

function verifyAdminSessionToken(token) {
  if (!token || !token.startsWith('session:')) return null;
  const session = adminSessions.get(token);
  if (!session) return null;
  // Sessions expire after 24h
  if (Date.now() - session.createdAt > 24 * 60 * 60 * 1000) {
    adminSessions.delete(token);
    return null;
  }
  // Verify user still active
  const user = db.prepare('SELECT * FROM admin_users WHERE username = ? AND status = ?').get(session.username, 'active');
  if (!user) { adminSessions.delete(token); return null; }
  return { user, role: session.role };
}

// Cleanup expired sessions every hour
setInterval(() => {
  const now = Date.now();
  for (const [token, session] of adminSessions) {
    if (now - session.createdAt > 24 * 60 * 60 * 1000) adminSessions.delete(token);
  }
}, 3600000);

// ── Auth middleware (admin) ────────────────────────────────
app.use('/api', (req, res, next) => {
  // Skip client routes (they use JWT) and webhooks
  if (req.path.startsWith('/client/') || req.path.startsWith('/webhook/')) return next();
  // Skip admin login route
  if (req.path === '/admin/login') return next();

  const token = req.headers['x-auth-token'] || req.query.token;

  // Master token = admin role
  if (token === AUTH_TOKEN) {
    req.adminRole = 'admin';
    return next();
  }

  // Verify HMAC-signed session token
  const session = verifyAdminSessionToken(token);
  if (session) {
    req.adminRole = session.role;
    req.adminUser = session.user;
    return next();
  }

  return res.status(401).json({ error: 'Unauthorized' });
});

// ── Admin extra routes (plans, changelog, customers) ──────
app.use('/api', adminExtraRoutes);

// ── Self-update (admin only) ──────────────────────────────
const { execFile } = require('child_process');
const fs = require('fs');

app.post('/api/self-update', (req, res) => {
  if (req.adminRole !== 'admin') return res.status(403).json({ error: 'Только admin может обновлять панель' });

  // Check that /repo exists (mounted project dir)
  if (!fs.existsSync('/repo/.git')) {
    return res.status(500).json({ error: 'Директория проекта не примонтирована. Проверьте docker-compose.yml' });
  }

  // Step 1: git pull
  execFile('git', ['-C', '/repo', 'pull', '--ff-only'], { timeout: 30000 }, (err, stdout, stderr) => {
    if (err) {
      return res.status(500).json({ error: 'Git pull failed', details: (stderr || err.message).slice(0, 500) });
    }

    const gitOutput = stdout.trim();

    // If already up to date
    if (gitOutput.includes('Already up to date') || gitOutput.includes('Already up-to-date')) {
      return res.json({ status: 'up-to-date', message: 'Уже актуальная версия' });
    }

    // Step 2: Rebuild and restart in background (detached so response goes back before container dies)
    const child = execFile('sh', ['-c', 'cd /repo && docker compose up -d --build --force-recreate 2>&1'], {
      timeout: 0,
      detached: true,
      stdio: 'ignore',
    });
    child.unref();

    res.json({ status: 'updating', message: 'Обновление запущено. Панель перезапустится через ~30 сек.', gitOutput });
  });
});

// ── TOTP 2FA ──────────────────────────────────────────────
const TOTP_ISSUER = 'MTG Panel';

function getTotpSecret() {
  const row = db.prepare("SELECT value FROM settings WHERE key='totp_secret'").get();
  return row ? row.value : null;
}
function isTotpEnabled() {
  const row = db.prepare("SELECT value FROM settings WHERE key='totp_enabled'").get();
  return row && row.value === '1';
}

app.get('/api/totp/status', (req, res) => {
  const token = req.headers['x-auth-token'];
  if (token !== AUTH_TOKEN) return res.status(401).json({ error: 'Unauthorized' });
  res.json({ enabled: isTotpEnabled() });
});
app.post('/api/totp/setup', async (req, res) => {
  const token = req.headers['x-auth-token'];
  if (token !== AUTH_TOKEN) return res.status(401).json({ error: 'Unauthorized' });
  const secret = authenticator.generateSecret();
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('totp_secret', ?)").run(secret);
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('totp_enabled', '0')").run();
  res.json({ secret, qr: authenticator.keyuri('admin', TOTP_ISSUER, secret) });
});
app.post('/api/totp/verify', (req, res) => {
  const token = req.headers['x-auth-token'];
  if (token !== AUTH_TOKEN) return res.status(401).json({ error: 'Unauthorized' });
  const { code } = req.body;
  const secret = getTotpSecret();
  if (!secret) return res.status(400).json({ error: 'Setup first' });
  if (authenticator.verify(code, secret)) {
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('totp_enabled', '1')").run();
    res.json({ ok: true });
  } else { res.status(400).json({ error: 'Invalid code' }); }
});
app.post('/api/totp/disable', (req, res) => {
  const token = req.headers['x-auth-token'];
  if (token !== AUTH_TOKEN) return res.status(401).json({ error: 'Unauthorized' });
  const { code } = req.body;
  const secret = getTotpSecret();
  if (secret && !authenticator.verify(code, secret)) {
    return res.status(400).json({ error: 'Invalid code' });
  }
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('totp_enabled', '0')").run();
  res.json({ ok: true });
});

// ── НПД (Мой налог) settings ─────────────────────────────
const nalog = require('./nalog');

app.get('/api/npd/settings', (req, res) => {
  const keys = ['npd_enabled', 'npd_inn', 'npd_password', 'npd_proxy'];
  const result = {};
  for (const key of keys) {
    const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key);
    result[key] = row ? row.value : '';
  }
  // Маскируем пароль в ответе
  if (result.npd_password) result.npd_password = '••••••••';
  res.json(result);
});

app.post('/api/npd/settings', (req, res) => {
  const { npd_enabled, npd_inn, npd_password, npd_proxy } = req.body;
  if (npd_inn !== undefined) {
    const sanitized = String(npd_inn).replace(/\D/g, '');
    if (sanitized && sanitized.length !== 12) {
      return res.status(400).json({ error: 'ИНН должен содержать 12 цифр' });
    }
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('npd_inn', ?)").run(sanitized);
  }
  if (npd_password !== undefined && npd_password !== '••••••••') {
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('npd_password', ?)").run(npd_password);
  }
  if (npd_proxy !== undefined) {
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('npd_proxy', ?)").run(String(npd_proxy).trim());
  }
  if (npd_enabled !== undefined) {
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('npd_enabled', ?)").run(npd_enabled ? '1' : '0');
  }
  res.json({ ok: true });
});

app.post('/api/npd/test', async (req, res) => {
  try {
    const result = await nalog.testConnection();
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ── .env Settings (admin only) ────────────────────────────
const ENV_PATH = '/repo/.env';
const ENV_GROUPS = {
  'Основные': ['AUTH_TOKEN', 'PORT', 'DATA_DIR', 'JWT_SECRET'],
  'YooKassa': ['YOOKASSA_SHOP_ID', 'YOOKASSA_SECRET_KEY'],
  'SMTP (Почта)': ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM'],
  'Telegram': ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_BOT_USERNAME'],
  'URLs': ['SITE_URL'],
};
const SENSITIVE_KEYS = new Set(['AUTH_TOKEN', 'JWT_SECRET', 'YOOKASSA_SECRET_KEY', 'SMTP_PASS', 'TELEGRAM_BOT_TOKEN']);

app.get('/api/env-settings', (req, res) => {
  if (req.adminRole !== 'admin') return res.status(403).json({ error: 'Только admin' });
  try {
    if (!fs.existsSync(ENV_PATH)) return res.json({ vars: {}, groups: ENV_GROUPS });
    const content = fs.readFileSync(ENV_PATH, 'utf8');
    const vars = {};
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      let val = trimmed.slice(eq + 1).trim();
      vars[key] = SENSITIVE_KEYS.has(key) ? '••••••••' : val;
    }
    res.json({ vars, groups: ENV_GROUPS, sensitive: [...SENSITIVE_KEYS] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/env-settings', (req, res) => {
  if (req.adminRole !== 'admin') return res.status(403).json({ error: 'Только admin' });
  try {
    const { vars } = req.body;
    if (!vars || typeof vars !== 'object') return res.status(400).json({ error: 'vars обязателен' });

    // Read existing .env to preserve sensitive values and comments
    let existingVars = {};
    let header = '';
    if (fs.existsSync(ENV_PATH)) {
      const content = fs.readFileSync(ENV_PATH, 'utf8');
      const headerLines = [];
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (trimmed.startsWith('#') || !trimmed) {
          if (Object.keys(existingVars).length === 0) headerLines.push(line);
          continue;
        }
        const eq = trimmed.indexOf('=');
        if (eq === -1) continue;
        existingVars[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
      }
      header = headerLines.join('\n');
    }

    // Merge: keep sensitive values if masked
    const merged = { ...existingVars };
    for (const [key, val] of Object.entries(vars)) {
      if (SENSITIVE_KEYS.has(key) && val === '••••••••') continue; // keep existing
      merged[key] = val;
    }

    // Build .env content grouped
    const lines = header ? [header, ''] : [];
    const written = new Set();
    for (const [group, keys] of Object.entries(ENV_GROUPS)) {
      lines.push(`# ${group}`);
      for (const key of keys) {
        if (merged[key] !== undefined) {
          lines.push(`${key}=${merged[key]}`);
          written.add(key);
        }
      }
      lines.push('');
    }
    // Any extra vars not in groups
    for (const [key, val] of Object.entries(merged)) {
      if (!written.has(key)) lines.push(`${key}=${val}`);
    }

    fs.writeFileSync(ENV_PATH, lines.join('\n').trimEnd() + '\n');
    res.json({ ok: true, message: 'Настройки сохранены. Для применения изменений перезапустите контейнер.' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Nodes ─────────────────────────────────────────────────
app.get('/api/nodes', (req, res) => {
  res.json(db.prepare('SELECT id, name, host, ssh_user, ssh_port, base_dir, start_port, created_at, flag, agent_port FROM nodes').all());
});

app.post('/api/nodes', (req, res) => {
  const { name, host, ssh_user, ssh_port, ssh_key, ssh_password, base_dir, start_port, flag, agent_port } = req.body;
  if (!name || !host) return res.status(400).json({ error: 'name и host обязательны' });
  const result = db.prepare(
    'INSERT INTO nodes (name, host, ssh_user, ssh_port, ssh_key, ssh_password, base_dir, start_port, flag, agent_port) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(name, host, ssh_user||'root', ssh_port||22, ssh_key||null, ssh_password||null, base_dir||'/opt/mtg/users', start_port||4433, flag||null, agent_port||null);
  res.json({ id: result.lastInsertRowid, name, host });
});

app.put('/api/nodes/:id', (req, res) => {
  const { name, host, ssh_user, ssh_port, ssh_key, ssh_password, base_dir, start_port, flag, agent_port } = req.body;
  const node = db.prepare('SELECT * FROM nodes WHERE id = ?').get(req.params.id);
  if (!node) return res.status(404).json({ error: 'Node not found' });
  db.prepare(
    'UPDATE nodes SET name=?, host=?, ssh_user=?, ssh_port=?, ssh_key=?, ssh_password=?, base_dir=?, start_port=?, flag=?, agent_port=? WHERE id=?'
  ).run(
    name||node.name, host||node.host, ssh_user||node.ssh_user, ssh_port||node.ssh_port,
    ssh_key!==undefined ? ssh_key : node.ssh_key,
    ssh_password!==undefined ? ssh_password : node.ssh_password,
    base_dir||node.base_dir, start_port||node.start_port,
    flag!==undefined ? flag : node.flag,
    agent_port!==undefined ? (agent_port||null) : node.agent_port,
    req.params.id
  );
  res.json({ ok: true });
});

app.delete('/api/nodes/:id', (req, res) => {
  db.prepare('DELETE FROM nodes WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// Check agent health on a node
app.get('/api/nodes/:id/check-agent', async (req, res) => {
  const node = db.prepare('SELECT * FROM nodes WHERE id = ?').get(req.params.id);
  if (!node) return res.status(404).json({ error: 'Not found' });
  if (!node.agent_port) return res.json({ available: false, reason: 'no agent_port configured' });
  try {
    const ok = await ssh.checkAgentHealth(node);
    res.json({ available: ok });
  } catch (e) {
    res.json({ available: false, reason: e.message });
  }
});

// Update agent on node via SSH
app.post('/api/nodes/:id/update-agent', async (req, res) => {
  const node = db.prepare('SELECT * FROM nodes WHERE id = ?').get(req.params.id);
  if (!node) return res.status(404).json({ error: 'Not found' });
  const token = process.env.AGENT_TOKEN || 'mtg-agent-secret';
  // Use wget (more universally available than curl), write to temp file
  const RAW = 'https://raw.githubusercontent.com/Reibik/mtg-adminpanel/main/mtg-agent';
  const cmd = [
    `mkdir -p /opt/mtg-agent && cd /opt/mtg-agent`,
    `wget -q "${RAW}/main.py" -O main.py`,
    `wget -q "${RAW}/docker-compose.yml" -O docker-compose.yml`,
    `echo "AGENT_TOKEN=${token}" > .env`,
    `docker compose down 2>/dev/null || true`,
    `docker compose up -d`,
    `echo "==> Done"`
  ].join(' && ');
  try {
    const r = await ssh.sshExec(node, cmd);
    const ok = r.output.includes('Done');
    res.json({ ok, output: r.output.slice(-800) });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/nodes/:id/check', async (req, res) => {
  const node = db.prepare('SELECT * FROM nodes WHERE id = ?').get(req.params.id);
  if (!node) return res.status(404).json({ error: 'Not found' });
  try { res.json({ online: await ssh.checkNode(node) }); }
  catch (e) { res.json({ online: false, error: e.message }); }
});

app.get('/api/nodes/:id/traffic', async (req, res) => {
  const node = db.prepare('SELECT * FROM nodes WHERE id = ?').get(req.params.id);
  if (!node) return res.status(404).json({ error: 'Not found' });
  try { res.json(await ssh.getTraffic(node)); }
  catch (_) { res.json({}); }
});

app.get('/api/nodes/:id/mtg-version', async (req, res) => {
  const node = db.prepare('SELECT * FROM nodes WHERE id = ?').get(req.params.id);
  if (!node) return res.status(404).json({ error: 'Not found' });
  try {
    const r = await ssh.sshExec(node, "docker inspect nineseconds/mtg:2 --format 'mtg:2 | built {{.Created}}' 2>/dev/null | head -1");
    res.json({ version: (r.output||'').trim().split('\n')[0]||'unknown', raw: r.output });
  } catch (e) { res.json({ version: 'error', error: e.message }); }
});

// Check agent version on a node
app.get('/api/nodes/:id/agent-version', async (req, res) => {
  const node = db.prepare('SELECT * FROM nodes WHERE id = ?').get(req.params.id);
  if (!node) return res.status(404).json({ error: 'Not found' });
  if (!node.agent_port) return res.json({ version: null, reason: 'no agent_port' });
  try {
    const r = await ssh.sshExec(node, `curl -s -m 5 http://127.0.0.1:${node.agent_port}/version 2>/dev/null || echo '{"version":"unknown"}'`);
    const parsed = JSON.parse((r.output||'{}').trim());
    res.json({ version: parsed.version || 'unknown' });
  } catch (e) { res.json({ version: 'error', error: e.message }); }
});

app.post('/api/nodes/:id/mtg-update', async (req, res) => {
  const node = db.prepare('SELECT * FROM nodes WHERE id = ?').get(req.params.id);
  if (!node) return res.status(404).json({ error: 'Not found' });
  try {
    const r = await ssh.sshExec(node, 'docker pull nineseconds/mtg:2 2>&1 | tail -3');
    res.json({ ok: true, output: r.output });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/status', async (req, res) => {
  const nodes = db.prepare('SELECT * FROM nodes').all();
  const results = await Promise.allSettled(
    nodes.map(async node => {
      const status = await ssh.getNodeStatus(node);
      // online_users only via agent (fast) — skip SSH nodes to avoid slowdown
      let online_users = 0;
      if (node.agent_port) {
        try {
          const remoteUsers = await ssh.getRemoteUsers(node);
          online_users = remoteUsers.filter(u => (u.connections || 0) > 0).length;
        } catch (_) {}
      }
      return { id: node.id, name: node.name, host: node.host, ...status, online_users };
    })
  );
  res.json(results.map((r, i) => r.status === 'fulfilled'
    ? r.value
    : { id: nodes[i].id, name: nodes[i].name, online: false, online_users: 0 }
  ));
});

// ── Users ─────────────────────────────────────────────────
app.get('/api/nodes/:id/users', async (req, res) => {
  const node = db.prepare('SELECT * FROM nodes WHERE id = ?').get(req.params.id);
  if (!node) return res.status(404).json({ error: 'Not found' });
  const dbUsers = db.prepare('SELECT * FROM users WHERE node_id = ?').all(req.params.id);

  const mkUser = (u, remote) => ({
    ...u,
    connections: remote ? remote.connections : 0,
    running: remote ? !remote.status.includes('stopped') : false,
    is_online: remote ? (remote.connections || 0) > 0 : false,
    link: `tg://proxy?server=${node.host}&port=${u.port}&secret=${u.secret}`,
    expired: u.expires_at ? new Date(u.expires_at) < new Date() : false,
  });

  try {
    const remoteUsers = await ssh.getRemoteUsers(node);

    // Real-time device limit enforcement
    for (const remote of remoteUsers) {
      const dbUser = dbUsers.find(u => u.name === remote.name);
      if (dbUser && dbUser.max_devices && (remote.connections || 0) > dbUser.max_devices) {
        console.log(`⚠️ Device limit exceeded: ${remote.name} (${remote.connections}/${dbUser.max_devices}) — stopping`);
        ssh.stopRemoteUser(node, remote.name).catch(() => {});
        db.prepare('UPDATE users SET status=? WHERE node_id=? AND name=?').run('stopped', req.params.id, remote.name);
        remote.status = 'stopped';
        remote.connections = 0;
      }
      if ((remote.connections || 0) > 0) {
        db.prepare("UPDATE users SET last_seen_at=datetime('now') WHERE node_id=? AND name=?")
          .run(req.params.id, remote.name);
      }
    }

    res.json(dbUsers.map(u => mkUser(u, remoteUsers.find(r => r.name === u.name))));
  } catch (_) {
    res.json(dbUsers.map(u => mkUser(u, null)));
  }
});

app.post('/api/nodes/:id/sync', async (req, res) => {
  const node = db.prepare('SELECT * FROM nodes WHERE id = ?').get(req.params.id);
  if (!node) return res.status(404).json({ error: 'Node not found' });
  try {
    const remoteUsers = await ssh.getRemoteUsers(node);
    let imported = 0;
    for (const u of remoteUsers) {
      const exists = db.prepare('SELECT id FROM users WHERE node_id = ? AND name = ?').get(req.params.id, u.name);
      if (!exists) {
        db.prepare('INSERT INTO users (node_id, name, port, secret, note, expires_at, traffic_limit_gb) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run(req.params.id, u.name, u.port, u.secret, '', null, null);
        imported++;
      }
    }
    res.json({ imported, total: remoteUsers.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/nodes/:id/users', async (req, res) => {
  const node = db.prepare('SELECT * FROM nodes WHERE id = ?').get(req.params.id);
  if (!node) return res.status(404).json({ error: 'Node not found' });
  const { name, note, expires_at, traffic_limit_gb } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  if (db.prepare('SELECT id FROM users WHERE node_id = ? AND name = ?').get(req.params.id, name)) {
    return res.status(400).json({ error: 'User already exists' });
  }
  try {
    const { port, secret } = await ssh.createRemoteUser(node, name);
    const result = db.prepare(
      'INSERT INTO users (node_id, name, port, secret, note, expires_at, traffic_limit_gb) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(req.params.id, name, port, secret, note||'', expires_at||null, traffic_limit_gb||null);
    res.json({ id: result.lastInsertRowid, name, port, secret, note: note||'',
      expires_at: expires_at||null, traffic_limit_gb: traffic_limit_gb||null,
      link: `tg://proxy?server=${node.host}&port=${port}&secret=${secret}` });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/nodes/:id/users/:name', (req, res) => {
  const { note, expires_at, traffic_limit_gb, billing_price, billing_currency, billing_period,
    billing_paid_until, billing_status, max_devices, traffic_reset_interval } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE node_id = ? AND name = ?').get(req.params.id, req.params.name);
  if (!user) return res.status(404).json({ error: 'User not found' });

  // Calculate next_reset_at if interval changed
  let next_reset_at = user.next_reset_at;
  const newInterval = traffic_reset_interval !== undefined ? traffic_reset_interval : user.traffic_reset_interval;
  if (traffic_reset_interval !== undefined && traffic_reset_interval !== user.traffic_reset_interval) {
    next_reset_at = calcNextReset(traffic_reset_interval);
  }

  db.prepare(`UPDATE users SET
    note=?, expires_at=?, traffic_limit_gb=?,
    billing_price=?, billing_currency=?, billing_period=?, billing_paid_until=?, billing_status=?,
    max_devices=?, traffic_reset_interval=?, next_reset_at=?
    WHERE node_id=? AND name=?`).run(
    note!==undefined ? note : user.note,
    expires_at!==undefined ? expires_at : user.expires_at,
    traffic_limit_gb!==undefined ? traffic_limit_gb : user.traffic_limit_gb,
    billing_price!==undefined ? billing_price : user.billing_price,
    billing_currency||user.billing_currency||'RUB',
    billing_period||user.billing_period||'monthly',
    billing_paid_until!==undefined ? billing_paid_until : user.billing_paid_until,
    billing_status||user.billing_status||'active',
    max_devices!==undefined ? max_devices : user.max_devices,
    newInterval||null,
    next_reset_at||null,
    req.params.id, req.params.name
  );
  res.json({ ok: true });
});

app.delete('/api/nodes/:id/users/:name', async (req, res) => {
  const node = db.prepare('SELECT * FROM nodes WHERE id = ?').get(req.params.id);
  if (!node) return res.status(404).json({ error: 'Node not found' });
  try {
    await ssh.removeRemoteUser(node, req.params.name);
    db.prepare('DELETE FROM users WHERE node_id = ? AND name = ?').run(req.params.id, req.params.name);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Stop: save traffic snapshot before stopping so UI keeps last known value
app.post('/api/nodes/:id/users/:name/stop', async (req, res) => {
  const node = db.prepare('SELECT * FROM nodes WHERE id = ?').get(req.params.id);
  if (!node) return res.status(404).json({ error: 'Node not found' });
  try {
    // Save traffic snapshot before stopping
    try {
      const traffic = await ssh.getTraffic(node);
      const ut = traffic[req.params.name];
      if (ut) {
        db.prepare('UPDATE users SET traffic_rx_snap=?, traffic_tx_snap=? WHERE node_id=? AND name=?')
          .run(ut.rx, ut.tx, req.params.id, req.params.name);
      }
    } catch (_) {}
    await ssh.stopRemoteUser(node, req.params.name);
    db.prepare('UPDATE users SET status=? WHERE node_id=? AND name=?').run('stopped', req.params.id, req.params.name);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/nodes/:id/users/:name/start', async (req, res) => {
  const node = db.prepare('SELECT * FROM nodes WHERE id = ?').get(req.params.id);
  if (!node) return res.status(404).json({ error: 'Node not found' });
  try {
    await ssh.startRemoteUser(node, req.params.name);
    db.prepare('UPDATE users SET status=? WHERE node_id=? AND name=?').run('active', req.params.id, req.params.name);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Reset traffic: restart container (clears MTG counter) + record timestamp
app.post('/api/nodes/:id/users/:name/reset-traffic', async (req, res) => {
  const node = db.prepare('SELECT * FROM nodes WHERE id = ?').get(req.params.id);
  if (!node) return res.status(404).json({ error: 'Node not found' });
  try {
    await ssh.stopRemoteUser(node, req.params.name);
    await ssh.startRemoteUser(node, req.params.name);
    db.prepare(`UPDATE users SET
      traffic_reset_at=datetime('now'), traffic_rx_snap=NULL, traffic_tx_snap=NULL,
      status='active' WHERE node_id=? AND name=?`
    ).run(req.params.id, req.params.name);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/nodes/:id/users/:name/history', (req, res) => {
  const rows = db.prepare(
    'SELECT connections, recorded_at FROM connections_history WHERE node_id=? AND user_name=? ORDER BY recorded_at DESC LIMIT 48'
  ).all(req.params.id, req.params.name);
  res.json(rows.reverse());
});

// ── Admin Role Info ────────────────────────────────────────
app.get('/api/admin/role', (req, res) => {
  res.json({ role: req.adminRole || 'admin' });
});

// ── Admin Users Management (admin only) ───────────────────
function requireAdmin(req, res, next) {
  if (req.adminRole !== 'admin') return res.status(403).json({ error: 'Доступ запрещён' });
  next();
}

app.get('/api/admin/users', requireAdmin, (req, res) => {
  const users = db.prepare(
    'SELECT id, username, role, display_name, status, created_at, last_login_at FROM admin_users ORDER BY created_at'
  ).all();
  res.json(users);
});

app.post('/api/admin/users', requireAdmin, async (req, res) => {
  const { username, password, role, display_name } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Логин и пароль обязательны' });
  if (!['admin', 'moderator', 'support'].includes(role)) return res.status(400).json({ error: 'Роль: admin, moderator, support' });
  if (password.length < 6) return res.status(400).json({ error: 'Пароль минимум 6 символов' });
  const existing = db.prepare('SELECT id FROM admin_users WHERE username = ?').get(username);
  if (existing) return res.status(409).json({ error: 'Пользователь уже существует' });
  const hash = await bcrypt.hash(password, 12);
  const result = db.prepare(
    'INSERT INTO admin_users (username, password_hash, role, display_name) VALUES (?, ?, ?, ?)'
  ).run(username, hash, role, display_name || null);
  res.json({ id: result.lastInsertRowid });
});

app.put('/api/admin/users/:id', requireAdmin, async (req, res) => {
  const user = db.prepare('SELECT * FROM admin_users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'Не найден' });
  const { role, display_name, password, status } = req.body;
  if (role && !['admin', 'moderator', 'support'].includes(role)) return res.status(400).json({ error: 'Роль: admin, moderator, support' });
  let hash = user.password_hash;
  if (password) {
    if (password.length < 6) return res.status(400).json({ error: 'Пароль минимум 6 символов' });
    hash = await bcrypt.hash(password, 12);
  }
  db.prepare('UPDATE admin_users SET role=?, display_name=?, password_hash=?, status=? WHERE id=?').run(
    role || user.role, display_name !== undefined ? display_name : user.display_name,
    hash, status || user.status, user.id
  );
  res.json({ ok: true });
});

app.delete('/api/admin/users/:id', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM admin_users WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ── SPA fallback ──────────────────────────────────────────
app.get('/admin*', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});
app.get('*', (req, res) => {
  // Serve client SPA for all non-API, non-admin routes
  const clientIndex = path.join(clientDistPath, 'index.html');
  const fs = require('fs');
  if (fs.existsSync(clientIndex)) {
    res.sendFile(clientIndex);
  } else {
    // Never fall back to admin panel — show error instead
    res.status(503).send('<html><body style="background:#080a12;color:#fff;font-family:sans-serif;display:flex;justify-content:center;align-items:center;height:100vh;margin:0"><div style="text-align:center"><h1>Сайт обновляется</h1><p>Клиентская часть ещё не собрана. Пересоберите Docker-образ:</p><pre style="background:#141728;padding:16px;border-radius:8px;text-align:left">cd /opt/mtg-adminpanel\ndocker compose up -d --build</pre><p style="margin-top:24px"><a href="/admin" style="color:#7c6ff7">Перейти в панель администратора →</a></p></div></body></html>');
  }
});

// ── Helpers ───────────────────────────────────────────────
function calcNextReset(interval) {
  if (!interval || interval === 'never') return null;
  const now = new Date();
  if (interval === 'daily')   { now.setDate(now.getDate() + 1); now.setHours(0,0,0,0); }
  if (interval === 'monthly') { now.setMonth(now.getMonth() + 1); now.setDate(1); now.setHours(0,0,0,0); }
  if (interval === 'yearly')  { now.setFullYear(now.getFullYear() + 1); now.setMonth(0); now.setDate(1); now.setHours(0,0,0,0); }
  return now.toISOString().replace('T',' ').slice(0,19);
}

function parseBytes(str) {
  if (!str) return 0;
  const m = str.match(/([\d.]+)(GB|MB|KB|B)/i);
  if (!m) return 0;
  const v = parseFloat(m[1]);
  const u = m[2].toUpperCase();
  if (u === 'GB') return Math.round(v * 1073741824);
  if (u === 'MB') return Math.round(v * 1048576);
  if (u === 'KB') return Math.round(v * 1024);
  return Math.round(v);
}

// ── Background jobs ───────────────────────────────────────

// Sync GitHub Releases → changelog table
async function syncGitHubChangelog() {
  try {
    const releases = await githubGet('/repos/Reibik/mtg-adminpanel/releases?per_page=50');
    if (!Array.isArray(releases)) return;

    for (const rel of releases) {
      if (!rel.tag_name || rel.draft) continue;
      const version = rel.tag_name.replace(/^v/, '');
      const title = rel.name || `v${version}`;
      const published = rel.published_at || new Date().toISOString();

      // Parse markdown body → clean array of items
      const changes = [];
      if (rel.body) {
        for (const line of rel.body.split('\n')) {
          const trimmed = line.trim();
          // Skip headings, empty lines
          if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('---')) continue;
          // Parse list items: "- text" or "* text"
          const m = trimmed.match(/^[-*]\s+\*{0,2}(.+?)\*{0,2}$/);
          if (m) {
            let item = m[1].trim();
            // Remove bold markers, backticks, leading/trailing punctuation
            item = item.replace(/\*{1,2}/g, '').replace(/`/g, '').trim();
            // Skip sub-items that are too technical
            if (item.length > 3 && item.length < 200) changes.push(item);
          }
        }
      }

      if (changes.length === 0) changes.push(title);

      const changesJson = JSON.stringify(changes);

      // Upsert: insert or update existing
      const existing = db.prepare('SELECT id, changes FROM changelog WHERE version = ?').get(version);
      if (existing) {
        // Update only if changes differ
        if (existing.changes !== changesJson) {
          db.prepare('UPDATE changelog SET title=?, changes=?, released_at=? WHERE id=?')
            .run(title, changesJson, published, existing.id);
        }
      } else {
        db.prepare('INSERT INTO changelog (version, title, changes, released_at) VALUES (?, ?, ?, ?)')
          .run(version, title, changesJson, published);
      }
    }
    console.log(`📋 Changelog synced: ${releases.length} releases`);
  } catch (e) {
    console.error('Changelog sync error:', e.message);
  }
}

async function recordHistory() {
  const nodes = db.prepare('SELECT * FROM nodes').all();
  for (const node of nodes) {
    try {
      const remoteUsers = await ssh.getRemoteUsers(node);
      const traffic = await ssh.getTraffic(node).catch(() => ({}));

      for (const u of remoteUsers) {
        const conns = u.connections || 0;
        db.prepare('INSERT INTO connections_history (node_id, user_name, connections) VALUES (?, ?, ?)')
          .run(node.id, u.name, conns);

        if (conns > 0) {
          db.prepare("UPDATE users SET last_seen_at=datetime('now') WHERE node_id=? AND name=?")
            .run(node.id, u.name);
        }

        // Device limit enforcement
        const dbUser = db.prepare('SELECT * FROM users WHERE node_id=? AND name=?').get(node.id, u.name);
        if (dbUser && dbUser.max_devices && conns > dbUser.max_devices) {
          console.log(`⚠️ Device limit exceeded: ${u.name} on node ${node.id} (${conns}/${dbUser.max_devices})`);
          try {
            await ssh.stopRemoteUser(node, u.name);
            db.prepare('UPDATE users SET status=? WHERE node_id=? AND name=?').run('stopped', node.id, u.name);
            console.log(`🛑 Auto-stopped ${u.name}: exceeded device limit`);
          } catch (e) { console.error('Failed to stop user:', e.message); }
        }
      }

      // Auto traffic reset check
      const usersToReset = db.prepare(`
        SELECT * FROM users WHERE node_id=? AND traffic_reset_interval IS NOT NULL
        AND traffic_reset_interval != 'never' AND next_reset_at IS NOT NULL
        AND next_reset_at <= datetime('now')
      `).all(node.id);

      for (const u of usersToReset) {
        try {
          // Accumulate total traffic before reset
          const t = traffic[u.name];
          if (t) {
            const rxBytes = parseBytes(t.rx) + (u.total_traffic_rx_bytes || 0);
            const txBytes = parseBytes(t.tx) + (u.total_traffic_tx_bytes || 0);
            db.prepare('UPDATE users SET total_traffic_rx_bytes=?, total_traffic_tx_bytes=? WHERE id=?')
              .run(rxBytes, txBytes, u.id);
          }
          // Reset traffic (restart container)
          await ssh.stopRemoteUser(node, u.name);
          await ssh.startRemoteUser(node, u.name);
          const next = calcNextReset(u.traffic_reset_interval);
          db.prepare(`UPDATE users SET traffic_reset_at=datetime('now'), traffic_rx_snap=NULL,
            traffic_tx_snap=NULL, next_reset_at=?, status='active' WHERE id=?`).run(next, u.id);
          console.log(`♻️ Auto-reset traffic for ${u.name} on node ${node.id}, next: ${next}`);
        } catch (e) { console.error(`Failed to auto-reset traffic for ${u.name}:`, e.message); }
      }

    } catch (_) {}
  }
  db.prepare("DELETE FROM connections_history WHERE recorded_at < datetime('now', '-24 hours')").run();
}

async function cleanExpiredUsers() {
  const expired = db.prepare(
    "SELECT u.id as user_id, u.name as user_name, u.node_id, u.port, u.secret, u.status, u.expires_at FROM users u WHERE u.expires_at IS NOT NULL AND u.expires_at < datetime('now')"
  ).all();
  for (const u of expired) {
    try {
      const node = db.prepare('SELECT * FROM nodes WHERE id=?').get(u.node_id);
      if (node) await ssh.removeRemoteUser(node, u.user_name);
      db.prepare('DELETE FROM users WHERE id=?').run(u.user_id);
      // Mark corresponding orders as expired
      db.prepare("UPDATE orders SET status = 'expired' WHERE node_id = ? AND user_name = ? AND status = 'active'").run(u.node_id, u.user_name);
      console.log(`🗑️ Auto-deleted expired user: ${u.user_name} on node ${u.node_id}`);
    } catch (e) { console.error(`Failed to delete expired user ${u.user_name}:`, e.message); }
  }
}

setInterval(recordHistory,     5  * 60 * 1000);
setInterval(cleanExpiredUsers, 60  * 60 * 1000);
setInterval(syncGitHubChangelog, 60 * 60 * 1000);
setInterval(() => clientRoutes.processAutoRenewals().catch(e => console.error('Auto-renewal error:', e)), 3600000);
setInterval(() => clientRoutes.checkPendingPayments().catch(e => console.error('Payment check error:', e)), 2 * 60 * 1000);

app.listen(PORT, () => {
  console.log(`🔒 MTG Panel running on http://0.0.0.0:${PORT}`);
  console.log(`🔑 Auth token: ${AUTH_TOKEN}`);
  console.log(`📦 Version: ${pkgVersion}`);
  setTimeout(recordHistory,     10000);
  setTimeout(cleanExpiredUsers,  5000);
  setTimeout(syncGitHubChangelog, 3000);
  setTimeout(() => clientRoutes.processAutoRenewals().catch(() => {}), 15000);
  setTimeout(() => clientRoutes.checkPendingPayments().catch(() => {}), 20000);
});
