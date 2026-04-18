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
const fs         = require('fs');

// Version: read from VERSION file (mounted at /repo/VERSION or fallback to package.json)
let pkgVersion = 'unknown';
try {
  const versionFile = fs.existsSync('/repo/VERSION') ? '/repo/VERSION' : path.join(__dirname, '../../VERSION');
  if (fs.existsSync(versionFile)) {
    pkgVersion = fs.readFileSync(versionFile, 'utf8').trim();
  } else {
    pkgVersion = require('../package.json').version;
  }
} catch (_) {}

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
    // v2.1.0 — VPN ST VILLAGE free proxy for VPN subscribers
    "ALTER TABLE orders ADD COLUMN is_vpn_free INTEGER DEFAULT 0",
    // v2.7.0 — Custom subscription name
    "ALTER TABLE orders ADD COLUMN custom_name TEXT DEFAULT NULL",
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

// ── Backup system (admin only) ────────────────────────────
const { execFile, execSync } = require('child_process');
const archiver = require('archiver');
const multer = require('multer');
const tar = require('tar');

const BACKUP_DIR = path.join(process.env.DATA_DIR || '/data', 'backups');
if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });

// List backups
app.get('/api/backups', (req, res) => {
  if (req.adminRole !== 'admin') return res.status(403).json({ error: 'Только admin' });
  try {
    const files = fs.readdirSync(BACKUP_DIR)
      .filter(f => f.endsWith('.tar.gz'))
      .map(f => {
        const stat = fs.statSync(path.join(BACKUP_DIR, f));
        return { name: f, size: stat.size, created: stat.mtime.toISOString() };
      })
      .sort((a, b) => new Date(b.created) - new Date(a.created));
    
    // Auto-backup settings
    const autoSetting = db.prepare("SELECT value FROM settings WHERE key='backup_interval'").get();
    const lastBackup = db.prepare("SELECT value FROM settings WHERE key='backup_last'").get();
    
    res.json({
      backups: files,
      autoBackup: {
        interval: autoSetting?.value || 'off',
        lastBackup: lastBackup?.value || null,
      },
    });
  } catch (e) {
    res.status(500).json({ error: 'Ошибка чтения бекапов: ' + e.message });
  }
});

// Create backup
app.post('/api/backups/create', async (req, res) => {
  if (req.adminRole !== 'admin') return res.status(403).json({ error: 'Только admin' });
  try {
    const result = await createBackup();
    res.json(result);
  } catch (e) {
    console.error('Backup create error:', e);
    res.status(500).json({ error: 'Ошибка создания бекапа: ' + e.message });
  }
});

async function createBackup(label) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const filename = `backup_${label || timestamp}.tar.gz`;
  const filepath = path.join(BACKUP_DIR, filename);
  
  // First, make a safe copy of the database
  const dbPath = path.join(process.env.DATA_DIR || '/data', 'mtg-panel.db');
  const dbCopyPath = path.join(BACKUP_DIR, 'mtg-panel.db.bak');
  await db.backup(dbCopyPath);
  
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(filepath);
    const archive = archiver('tar', { gzip: true, gzipOptions: { level: 9 } });
    
    output.on('close', () => {
      // Clean up db copy
      try { fs.unlinkSync(dbCopyPath); } catch (_) {}
      
      // Update last backup time
      db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('backup_last', ?)").run(new Date().toISOString());
      
      const stat = fs.statSync(filepath);
      resolve({ name: filename, size: stat.size, created: stat.mtime.toISOString() });
    });
    
    archive.on('error', (err) => {
      try { fs.unlinkSync(dbCopyPath); } catch (_) {}
      reject(err);
    });
    
    archive.pipe(output);
    
    // Add database copy
    archive.file(dbCopyPath, { name: 'data/mtg-panel.db' });
    
    // Add .env if exists
    const envPath = '/repo/.env';
    if (fs.existsSync(envPath)) {
      archive.file(envPath, { name: '.env' });
    }
    
    // Add ssh_keys directory
    const sshKeysPath = '/repo/ssh_keys';
    if (fs.existsSync(sshKeysPath)) {
      archive.directory(sshKeysPath, 'ssh_keys');
    }
    
    // Add VERSION
    const versionPath = '/repo/VERSION';
    if (fs.existsSync(versionPath)) {
      archive.file(versionPath, { name: 'VERSION' });
    }
    
    // Add backup metadata
    const meta = {
      version: pkgVersion,
      commit: gitCommit,
      created: new Date().toISOString(),
      hostname: require('os').hostname(),
    };
    archive.append(JSON.stringify(meta, null, 2), { name: 'backup-meta.json' });
    
    archive.finalize();
  });
}

// Download backup
app.get('/api/backups/:name/download', (req, res) => {
  if (req.adminRole !== 'admin') return res.status(403).json({ error: 'Только admin' });
  const name = path.basename(req.params.name); // Prevent path traversal
  if (!name.endsWith('.tar.gz')) return res.status(400).json({ error: 'Invalid filename' });
  const filepath = path.join(BACKUP_DIR, name);
  if (!fs.existsSync(filepath)) return res.status(404).json({ error: 'Бекап не найден' });
  
  res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
  res.setHeader('Content-Type', 'application/gzip');
  fs.createReadStream(filepath).pipe(res);
});

// Delete backup
app.delete('/api/backups/:name', (req, res) => {
  if (req.adminRole !== 'admin') return res.status(403).json({ error: 'Только admin' });
  const name = path.basename(req.params.name);
  if (!name.endsWith('.tar.gz')) return res.status(400).json({ error: 'Invalid filename' });
  const filepath = path.join(BACKUP_DIR, name);
  if (!fs.existsSync(filepath)) return res.status(404).json({ error: 'Бекап не найден' });
  
  fs.unlinkSync(filepath);
  res.json({ ok: true });
});

// Upload and restore backup
const backupUpload = multer({
  dest: path.join(BACKUP_DIR, 'uploads'),
  limits: { fileSize: 500 * 1024 * 1024 }, // 500MB max
  fileFilter(req, file, cb) {
    if (file.originalname.endsWith('.tar.gz') || file.mimetype === 'application/gzip') {
      cb(null, true);
    } else {
      cb(new Error('Только .tar.gz файлы'));
    }
  },
});

app.post('/api/backups/restore', backupUpload.single('backup'), async (req, res) => {
  if (req.adminRole !== 'admin') return res.status(403).json({ error: 'Только admin' });
  if (!req.file) return res.status(400).json({ error: 'Файл не загружен' });
  
  const uploadedPath = req.file.path;
  const extractDir = path.join(BACKUP_DIR, 'restore-tmp');
  
  try {
    // Create auto-backup before restore
    await createBackup('pre-restore');
    
    // Extract
    if (fs.existsSync(extractDir)) fs.rmSync(extractDir, { recursive: true });
    fs.mkdirSync(extractDir, { recursive: true });
    
    execSync(`tar -xzf "${uploadedPath}" -C "${extractDir}"`, { timeout: 60000 });
    
    // Validate backup contents
    const metaPath = path.join(extractDir, 'backup-meta.json');
    if (!fs.existsSync(metaPath)) {
      throw new Error('Невалидный бекап: отсутствует backup-meta.json');
    }
    
    const dbFile = path.join(extractDir, 'data', 'mtg-panel.db');
    if (!fs.existsSync(dbFile)) {
      throw new Error('Невалидный бекап: отсутствует data/mtg-panel.db');
    }
    
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    
    // Restore database
    const targetDb = path.join(process.env.DATA_DIR || '/data', 'mtg-panel.db');
    fs.copyFileSync(dbFile, targetDb);
    
    // Restore .env
    const envFile = path.join(extractDir, '.env');
    if (fs.existsSync(envFile)) {
      fs.copyFileSync(envFile, '/repo/.env');
    }
    
    // Restore ssh_keys
    const sshDir = path.join(extractDir, 'ssh_keys');
    if (fs.existsSync(sshDir)) {
      const targetSsh = '/repo/ssh_keys';
      if (!fs.existsSync(targetSsh)) fs.mkdirSync(targetSsh, { recursive: true });
      for (const f of fs.readdirSync(sshDir)) {
        fs.copyFileSync(path.join(sshDir, f), path.join(targetSsh, f));
        fs.chmodSync(path.join(targetSsh, f), 0o600);
      }
    }
    
    // Cleanup
    fs.rmSync(extractDir, { recursive: true, force: true });
    fs.unlinkSync(uploadedPath);
    
    // Respond before restart
    res.json({
      ok: true,
      message: 'Бекап восстановлен. Панель перезапускается...',
      meta,
    });
    
    // Restart to reload DB
    setTimeout(() => process.exit(0), 1000);
  } catch (e) {
    // Cleanup on error
    try { fs.rmSync(extractDir, { recursive: true, force: true }); } catch (_) {}
    try { fs.unlinkSync(uploadedPath); } catch (_) {}
    console.error('Restore error:', e);
    res.status(500).json({ error: 'Ошибка восстановления: ' + e.message });
  }
});

// Auto-backup settings
app.put('/api/backups/auto', (req, res) => {
  if (req.adminRole !== 'admin') return res.status(403).json({ error: 'Только admin' });
  const { interval } = req.body; // 'off', 'daily', 'weekly'
  if (!['off', 'daily', 'weekly'].includes(interval)) {
    return res.status(400).json({ error: 'interval: off, daily, weekly' });
  }
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('backup_interval', ?)").run(interval);
  res.json({ ok: true, interval });
});

// Auto-backup job
async function runAutoBackup() {
  try {
    const setting = db.prepare("SELECT value FROM settings WHERE key='backup_interval'").get();
    const interval = setting?.value || 'off';
    if (interval === 'off') return;
    
    const lastBackup = db.prepare("SELECT value FROM settings WHERE key='backup_last'").get();
    const lastTime = lastBackup?.value ? new Date(lastBackup.value) : new Date(0);
    const now = new Date();
    
    const hours = (now - lastTime) / (1000 * 60 * 60);
    const needed = interval === 'daily' ? 24 : 168; // 24h or 7 days
    
    if (hours >= needed) {
      console.log(`📦 Auto-backup started (${interval})...`);
      const result = await createBackup(`auto-${interval}`);
      console.log(`✅ Auto-backup created: ${result.name} (${(result.size / 1024).toFixed(1)} KB)`);
      
      // Cleanup old auto-backups (keep last 5)
      const autoFiles = fs.readdirSync(BACKUP_DIR)
        .filter(f => f.startsWith('backup_auto-') && f.endsWith('.tar.gz'))
        .map(f => ({ name: f, time: fs.statSync(path.join(BACKUP_DIR, f)).mtime }))
        .sort((a, b) => b.time - a.time);
      
      for (const old of autoFiles.slice(5)) {
        fs.unlinkSync(path.join(BACKUP_DIR, old.name));
        console.log(`🗑️ Deleted old auto-backup: ${old.name}`);
      }
    }
  } catch (e) {
    console.error('Auto-backup error:', e.message);
  }
}

// ── Self-update (admin only) ──────────────────────────────
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

    // Step 2: Install backend deps if needed
    try {
      execSync('cd /repo/backend && npm install --production 2>&1', { timeout: 60000 });
    } catch (_) {}

    // Step 3: Build client
    try {
      execSync('cd /repo/client && npm install 2>&1 && npm run build 2>&1', { timeout: 120000 });
    } catch (buildErr) {
      return res.status(500).json({ error: 'Client build failed', details: (buildErr.message || '').slice(0, 500) });
    }

    // Step 4: Copy updated files into running app
    try {
      // Copy backend source
      execSync('cp -r /repo/backend/src/* /app/src/', { timeout: 10000 });
      // Copy built client
      execSync('rm -rf /app/public-client && cp -r /repo/backend/public-client /app/public-client', { timeout: 10000 });
      // Copy admin panel
      execSync('cp -r /repo/public/* /app/public/', { timeout: 10000 });
      // Copy package.json (for version)
      execSync('cp /repo/backend/package.json /app/package.json', { timeout: 5000 });
    } catch (copyErr) {
      return res.status(500).json({ error: 'Failed to copy files', details: (copyErr.message || '').slice(0, 500) });
    }

    // Step 5: Restart the container (graceful — docker will auto-restart it)
    res.json({ status: 'updating', message: 'Обновление установлено. Панель перезапускается...', gitOutput });

    // Give time for response to be sent, then exit — docker restart policy will restart us
    setTimeout(() => {
      process.exit(0);
    }, 1000);
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
      // Validate key format (only uppercase letters, digits, underscore)
      if (!/^[A-Z_][A-Z0-9_]*$/.test(String(key))) continue;
      // Sanitize value (strip newlines to prevent injection)
      merged[key] = String(val).replace(/[\r\n]/g, '');
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
  if (host.length > 255 || !/^[a-zA-Z0-9.\-:]+$/.test(host)) return res.status(400).json({ error: 'Invalid host' });
  if (ssh_port && (isNaN(ssh_port) || ssh_port < 1 || ssh_port > 65535)) return res.status(400).json({ error: 'Invalid SSH port' });
  if (agent_port && (isNaN(agent_port) || agent_port < 1 || agent_port > 65535)) return res.status(400).json({ error: 'Invalid agent port' });
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
  const nodeId = req.params.id;
  const node = db.prepare('SELECT * FROM nodes WHERE id = ?').get(nodeId);
  if (!node) return res.status(404).json({ error: 'Node not found' });

  try {
    const deleteNode = db.transaction(() => {
      db.prepare('DELETE FROM connections_history WHERE node_id = ?').run(nodeId);
      db.prepare('UPDATE payments SET order_id = NULL WHERE order_id IN (SELECT id FROM orders WHERE node_id = ?)').run(nodeId);
      db.prepare('DELETE FROM orders WHERE node_id = ?').run(nodeId);
      db.prepare('DELETE FROM nodes WHERE id = ?').run(nodeId);
    });
    deleteNode();
    res.json({ ok: true });
  } catch (e) {
    console.error(`Delete node #${nodeId} error:`, e.message);
    res.status(500).json({ error: 'Ошибка при удалении ноды' });
  }
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
  const agentPort = node.agent_port || 8081;
  const RAW = 'https://raw.githubusercontent.com/Reibik/mtg-adminpanel/main/mtg-agent';
  const cmd = [
    `mkdir -p /opt/mtg-agent && cd /opt/mtg-agent`,
    `wget -q "${RAW}/main.py" -O main.py || curl -fsSL "${RAW}/main.py" -o main.py`,
    `wget -q "${RAW}/docker-compose.yml" -O docker-compose.yml || curl -fsSL "${RAW}/docker-compose.yml" -o docker-compose.yml`,
    `printf "AGENT_TOKEN=${token}\\nAGENT_PORT=${agentPort}\\n" > .env`,
    `docker compose down 2>/dev/null || true`,
    `docker compose pull 2>/dev/null || true`,
    `docker compose up -d --build 2>&1`,
    `sleep 4`,
    `curl -s -m 5 http://127.0.0.1:${agentPort}/version 2>/dev/null || echo '{"version":"starting"}'`,
    `echo ""`,
    `echo "==> Done"`
  ].join(' && ');
  try {
    const r = await ssh.sshExec(node, cmd);
    const ok = r.output.includes('Done');
    // Try to extract new version from output
    let newVersion = null;
    try {
      const vMatch = r.output.match(/\{"version":"([^"]+)"\}/);
      if (vMatch) newVersion = vMatch[1];
    } catch {}
    res.json({ ok, version: newVersion, output: r.output.slice(-1200) });
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

  const cached = nodeCache.traffic[node.id];
  if (cached && (Date.now() - cached.ts) < CACHE_TTL * 3) {
    return res.json(cached.data);
  }
  await refreshNodeTrafficCache(node);
  res.json((nodeCache.traffic[node.id] || {}).data || {});
});

app.get('/api/nodes/:id/mtg-version', async (req, res) => {
  const node = db.prepare('SELECT * FROM nodes WHERE id = ?').get(req.params.id);
  if (!node) return res.status(404).json({ error: 'Not found' });
  try {
    const r = await ssh.sshExec(node, "docker inspect nineseconds/mtg:2 --format 'mtg:2 | built {{.Created}}' 2>/dev/null | head -1");
    res.json({ version: (r.output||'').trim().split('\n')[0]||'unknown', raw: r.output });
  } catch (e) { res.json({ version: 'error', error: e.message }); }
});

// Check agent version on a node (agent-first, SSH fallback)
app.get('/api/nodes/:id/agent-version', async (req, res) => {
  const node = db.prepare('SELECT * FROM nodes WHERE id = ?').get(req.params.id);
  if (!node) return res.status(404).json({ error: 'Not found' });
  if (!node.agent_port) return res.json({ version: null, reason: 'no_agent_port' });
  // Try direct HTTP to agent
  const ver = await ssh.getAgentVersion(node);
  if (ver) return res.json({ version: ver });
  // Fallback: SSH + curl
  try {
    const r = await ssh.sshExec(node, `curl -s -m 5 http://127.0.0.1:${node.agent_port}/version 2>/dev/null || echo '{"version":"unknown"}'`);
    const parsed = JSON.parse((r.output||'{}').trim());
    res.json({ version: parsed.version || 'unknown' });
  } catch (e) { res.json({ version: 'error', error: e.message }); }
});

// Node system metrics (via agent)
app.get('/api/nodes/:id/system', async (req, res) => {
  const node = db.prepare('SELECT * FROM nodes WHERE id = ?').get(req.params.id);
  if (!node) return res.status(404).json({ error: 'Not found' });
  const data = await ssh.getAgentSystem(node);
  if (!data) return res.json({ available: false });
  res.json({ available: true, ...data });
});

// Full node metrics (containers + system, via agent)
app.get('/api/nodes/:id/full-metrics', async (req, res) => {
  const node = db.prepare('SELECT * FROM nodes WHERE id = ?').get(req.params.id);
  if (!node) return res.status(404).json({ error: 'Not found' });
  const data = await ssh.getAgentFullMetrics(node);
  if (!data) return res.json({ available: false });
  res.json({ available: true, ...data });
});

// Container management via agent (restart/stop/start)
app.post('/api/nodes/:id/containers/:name/:action', async (req, res) => {
  const { id, name, action } = req.params;
  if (!['restart', 'stop', 'start'].includes(action)) return res.status(400).json({ error: 'Invalid action' });
  const node = db.prepare('SELECT * FROM nodes WHERE id = ?').get(id);
  if (!node) return res.status(404).json({ error: 'Not found' });

  // Try agent first (faster, no SSH overhead)
  const agentResult = await ssh.agentContainerAction(node, name, action);
  if (agentResult && agentResult.ok) return res.json(agentResult);

  // Fallback to SSH
  try {
    if (action === 'restart') {
      await ssh.sshExec(node, `cd ${node.base_dir}/${name} && docker compose restart 2>/dev/null`);
    } else if (action === 'stop') {
      await ssh.stopRemoteUser(node, name);
    } else {
      await ssh.startRemoteUser(node, name);
    }
    res.json({ ok: true, status: action + 'ed', via: 'ssh' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Container logs via agent
app.get('/api/nodes/:id/containers/:name/logs', async (req, res) => {
  const node = db.prepare('SELECT * FROM nodes WHERE id = ?').get(req.params.id);
  if (!node) return res.status(404).json({ error: 'Not found' });
  const tail = Math.min(Math.max(parseInt(req.query.tail) || 100, 1), 1000);

  // Try agent first
  const data = await ssh.agentContainerLogs(node, req.params.name, tail);
  if (data) return res.json(data);

  // Fallback to SSH
  try {
    const r = await ssh.sshExec(node, `docker logs --tail ${tail} --timestamps mtg-${req.params.name} 2>&1`);
    res.json({ container: `mtg-${req.params.name}`, logs: r.output, lines: tail, via: 'ssh' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/nodes/:id/mtg-update', async (req, res) => {
  const node = db.prepare('SELECT * FROM nodes WHERE id = ?').get(req.params.id);
  if (!node) return res.status(404).json({ error: 'Not found' });
  try {
    const r = await ssh.sshExec(node, 'docker pull nineseconds/mtg:2 2>&1 | tail -3');
    res.json({ ok: true, output: r.output });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Background cache for admin endpoints ──────────────────
const nodeCache = {
  status:  { data: null, updating: false },
  users:   {},   // { nodeId: { data: [...], ts: Date.now() } }
  traffic: {},   // { nodeId: { data: {...}, ts: Date.now() } }
};
const CACHE_TTL = 20000; // 20 seconds

async function refreshStatusCache() {
  if (nodeCache.status.updating) return;
  nodeCache.status.updating = true;
  try {
    const nodes = db.prepare('SELECT * FROM nodes').all();
    const results = await Promise.allSettled(
      nodes.map(async node => {
        const status = await ssh.getNodeStatus(node);
        let online_users = 0;
        let system = null;
        if (node.agent_port) {
          try {
            const fullData = await ssh.getAgentFullMetrics(node);
            if (fullData) {
              online_users = (fullData.containers || []).filter(c => (c.connections || 0) > 0).length;
              system = fullData.system || null;
            }
          } catch (_) {}
        }
        return { id: node.id, name: node.name, host: node.host, ...status, online_users, system };
      })
    );
    nodeCache.status.data = results.map((r, i) => r.status === 'fulfilled'
      ? r.value
      : { id: nodes[i].id, name: nodes[i].name, online: false, online_users: 0 }
    );
    nodeCache.status.ts = Date.now();
  } catch (e) {
    console.error('Status cache refresh error:', e.message);
  } finally {
    nodeCache.status.updating = false;
  }
}

async function refreshNodeUsersCache(node) {
  const key = node.id;
  try {
    const dbUsers = db.prepare('SELECT * FROM users WHERE node_id = ?').all(node.id);
    const remoteUsers = await ssh.getRemoteUsers(node);

    const mkUser = (u, remote) => ({
      ...u,
      connections: remote ? remote.connections : 0,
      running: remote ? !remote.status.includes('stopped') : false,
      is_online: remote ? (remote.connections || 0) > 0 : false,
      link: `tg://proxy?server=${node.host}&port=${u.port}&secret=${u.secret}`,
      expired: u.expires_at ? new Date(u.expires_at) < new Date() : false,
    });

    // Device limit enforcement + last_seen updates
    for (const remote of remoteUsers) {
      const dbUser = dbUsers.find(u => u.name === remote.name);
      if (dbUser && dbUser.max_devices && (remote.connections || 0) > dbUser.max_devices) {
        console.log(`⚠️ Device limit exceeded: ${remote.name} (${remote.connections}/${dbUser.max_devices}) — stopping`);
        ssh.stopRemoteUser(node, remote.name).catch(() => {});
        db.prepare('UPDATE users SET status=? WHERE node_id=? AND name=?').run('stopped', node.id, remote.name);
        remote.status = 'stopped';
        remote.connections = 0;
      }
      if ((remote.connections || 0) > 0) {
        db.prepare("UPDATE users SET last_seen_at=datetime('now') WHERE node_id=? AND name=?")
          .run(node.id, remote.name);
      }
    }

    nodeCache.users[key] = {
      data: dbUsers.map(u => mkUser(u, remoteUsers.find(r => r.name === u.name))),
      ts: Date.now(),
    };
  } catch (_) {
    const dbUsers = db.prepare('SELECT * FROM users WHERE node_id = ?').all(node.id);
    nodeCache.users[key] = {
      data: dbUsers.map(u => ({
        ...u, connections: 0, running: false, is_online: false,
        link: `tg://proxy?server=${node.host}&port=${u.port}&secret=${u.secret}`,
        expired: u.expires_at ? new Date(u.expires_at) < new Date() : false,
      })),
      ts: Date.now(),
    };
  }
}

async function refreshNodeTrafficCache(node) {
  try {
    const data = await ssh.getTraffic(node);
    nodeCache.traffic[node.id] = { data, ts: Date.now() };
  } catch (_) {
    nodeCache.traffic[node.id] = { data: {}, ts: Date.now() };
  }
}

async function refreshAllCaches() {
  const nodes = db.prepare('SELECT * FROM nodes').all();
  await refreshStatusCache();
  await Promise.allSettled(nodes.map(async n => {
    await refreshNodeUsersCache(n);
    await refreshNodeTrafficCache(n);
  }));
}

// Start background cache refresh
setInterval(refreshAllCaches, CACHE_TTL);
setTimeout(refreshAllCaches, 3000);

app.get('/api/status', async (req, res) => {
  if (nodeCache.status.data && (Date.now() - (nodeCache.status.ts || 0)) < CACHE_TTL * 3) {
    return res.json(nodeCache.status.data);
  }
  // Fallback: compute live if cache is empty
  await refreshStatusCache();
  res.json(nodeCache.status.data || []);
});

// ── Users ─────────────────────────────────────────────────
app.get('/api/nodes/:id/users', async (req, res) => {
  const node = db.prepare('SELECT * FROM nodes WHERE id = ?').get(req.params.id);
  if (!node) return res.status(404).json({ error: 'Not found' });

  const cached = nodeCache.users[node.id];
  if (cached && (Date.now() - cached.ts) < CACHE_TTL * 3) {
    return res.json(cached.data);
  }
  // Fallback: refresh this node's cache now
  await refreshNodeUsersCache(node);
  res.json((nodeCache.users[node.id] || {}).data || []);
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
  if (!/^[a-zA-Z0-9_-]{1,50}$/.test(name)) return res.status(400).json({ error: 'Invalid name: only a-z, 0-9, _, - allowed (max 50 chars)' });
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

// ── Migrate user to another node ──────────────────────────
app.post('/api/nodes/:id/users/:name/migrate', async (req, res) => {
  const { target_node_id } = req.body;
  if (!target_node_id) return res.status(400).json({ error: 'target_node_id required' });

  const sourceNode = db.prepare('SELECT * FROM nodes WHERE id = ?').get(req.params.id);
  if (!sourceNode) return res.status(404).json({ error: 'Source node not found' });

  const targetNode = db.prepare('SELECT * FROM nodes WHERE id = ?').get(target_node_id);
  if (!targetNode) return res.status(404).json({ error: 'Target node not found' });

  if (sourceNode.id === targetNode.id) return res.status(400).json({ error: 'Нельзя переносить на ту же ноду' });

  const user = db.prepare('SELECT * FROM users WHERE node_id = ? AND name = ?').get(req.params.id, req.params.name);
  if (!user) return res.status(404).json({ error: 'User not found' });

  try {
    // 1. Create proxy on target node (same name, gets new port + secret)
    const { port: newPort, secret: newSecret } = await ssh.createRemoteUser(targetNode, user.name);

    // 2. Remove proxy from source node
    await ssh.removeRemoteUser(sourceNode, user.name).catch(e => {
      console.error(`Warning: failed to remove ${user.name} from source node:`, e.message);
    });

    // 3. Update DB in transaction
    const migrateTransaction = db.transaction(() => {
      db.prepare(`UPDATE users SET node_id=?, port=?, secret=? WHERE id=?`)
        .run(targetNode.id, newPort, newSecret, user.id);
      // Update orders referencing this user
      db.prepare(`UPDATE orders SET node_id=? WHERE node_id=? AND user_name=?`)
        .run(targetNode.id, sourceNode.id, user.name);
    });
    migrateTransaction();

    // 4. Invalidate cache for both nodes
    delete nodeCache.users[sourceNode.id];
    delete nodeCache.users[targetNode.id];
    delete nodeCache.traffic[sourceNode.id];
    delete nodeCache.traffic[targetNode.id];

    res.json({
      ok: true,
      new_port: newPort,
      new_secret: newSecret,
      new_link: `tg://proxy?server=${targetNode.host}&port=${newPort}&secret=${newSecret}`,
      target_node: { id: targetNode.id, name: targetNode.name, host: targetNode.host },
    });
  } catch (e) {
    console.error(`Migrate ${user.name} error:`, e.message);
    res.status(500).json({ error: 'Ошибка миграции: ' + e.message });
  }
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
  try {
    const user = db.prepare('SELECT * FROM admin_users WHERE id = ?').get(req.params.id);
    if (!user) return res.status(404).json({ error: 'Пользователь не найден' });

    const adminCount = db.prepare("SELECT COUNT(*) as cnt FROM admin_users WHERE role = 'admin'").get().cnt;
    if (user.role === 'admin' && adminCount <= 1) {
      return res.status(400).json({ error: 'Нельзя удалить последнего администратора' });
    }

    db.prepare('DELETE FROM admin_users WHERE id = ?').run(req.params.id);
    res.json({ ok: true });
  } catch (e) {
    console.error(`Delete admin user #${req.params.id} error:`, e.message);
    res.status(500).json({ error: 'Ошибка при удалении пользователя' });
  }
});

// ── SPA fallback ──────────────────────────────────────────
app.get('/admin*', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});
app.get('*', (req, res) => {
  // Serve client SPA for all non-API, non-admin routes
  const clientIndex = path.join(clientDistPath, 'index.html');
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
setInterval(() => runAutoBackup().catch(e => console.error('Auto-backup error:', e)), 60 * 60 * 1000);
setInterval(() => clientRoutes.checkVpnFreeProxies().catch(e => console.error('VPN free proxy check error:', e)), 6 * 3600000);

app.listen(PORT, () => {
  console.log(`🔒 MTG Panel running on http://0.0.0.0:${PORT}`);
  console.log(`🔑 Auth token: ${AUTH_TOKEN}`);
  console.log(`📦 Version: ${pkgVersion}`);
  setTimeout(recordHistory,     10000);
  setTimeout(cleanExpiredUsers,  5000);
  setTimeout(syncGitHubChangelog, 3000);
  setTimeout(() => clientRoutes.processAutoRenewals().catch(() => {}), 15000);
  setTimeout(() => clientRoutes.checkPendingPayments().catch(() => {}), 20000);
  setTimeout(() => runAutoBackup().catch(() => {}), 30000);
  setTimeout(() => clientRoutes.checkVpnFreeProxies().catch(() => {}), 60000);
});
