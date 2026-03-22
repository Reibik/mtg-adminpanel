const express = require('express');
const router = express.Router();
const db = require('../db');
const ssh = require('../ssh');
const yookassa = require('../yookassa');

// All routes here are under /api and protected by admin AUTH_TOKEN middleware (already in app.js)

// ═══════════════════════════════════════════════════════════
// PLANS MANAGEMENT
// ═══════════════════════════════════════════════════════════

router.get('/plans', (req, res) => {
  res.json(db.prepare('SELECT * FROM plans ORDER BY sort_order, price').all());
});

router.post('/plans', (req, res) => {
  const { name, description, price, currency, period, max_devices, traffic_limit_gb,
          traffic_reset_interval, location_ids, is_active, sort_order } = req.body;
  if (!name || price == null) return res.status(400).json({ error: 'name и price обязательны' });

  const result = db.prepare(
    `INSERT INTO plans (name, description, price, currency, period, max_devices,
     traffic_limit_gb, traffic_reset_interval, location_ids, is_active, sort_order)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(name, description || '', price, currency || 'RUB', period || 'monthly',
    max_devices || 3, traffic_limit_gb || null, traffic_reset_interval || 'monthly',
    JSON.stringify(location_ids || []), is_active !== undefined ? is_active : 1, sort_order || 0);

  res.json({ id: result.lastInsertRowid });
});

router.put('/plans/:id', (req, res) => {
  const plan = db.prepare('SELECT * FROM plans WHERE id = ?').get(req.params.id);
  if (!plan) return res.status(404).json({ error: 'Plan not found' });

  const { name, description, price, currency, period, max_devices, traffic_limit_gb,
          traffic_reset_interval, location_ids, is_active, sort_order } = req.body;

  db.prepare(
    `UPDATE plans SET name=?, description=?, price=?, currency=?, period=?, max_devices=?,
     traffic_limit_gb=?, traffic_reset_interval=?, location_ids=?, is_active=?, sort_order=?
     WHERE id=?`
  ).run(
    name || plan.name, description !== undefined ? description : plan.description,
    price !== undefined ? price : plan.price, currency || plan.currency, period || plan.period,
    max_devices !== undefined ? max_devices : plan.max_devices,
    traffic_limit_gb !== undefined ? traffic_limit_gb : plan.traffic_limit_gb,
    traffic_reset_interval || plan.traffic_reset_interval,
    location_ids ? JSON.stringify(location_ids) : plan.location_ids,
    is_active !== undefined ? is_active : plan.is_active,
    sort_order !== undefined ? sort_order : plan.sort_order,
    req.params.id
  );
  res.json({ ok: true });
});

router.delete('/plans/:id', (req, res) => {
  db.prepare('DELETE FROM plans WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// VPN free plan setting
router.get('/vpn-free-plan', (req, res) => {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'vpn_free_plan_id'").get();
  res.json({ plan_id: row ? Number(row.value) : null });
});

router.post('/vpn-free-plan', (req, res) => {
  const { plan_id } = req.body;
  if (plan_id === null || plan_id === undefined) {
    db.prepare("DELETE FROM settings WHERE key = 'vpn_free_plan_id'").run();
  } else {
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('vpn_free_plan_id', ?)").run(String(plan_id));
  }
  res.json({ ok: true });
});

// ═══════════════════════════════════════════════════════════
// CHANGELOG MANAGEMENT
// ═══════════════════════════════════════════════════════════

router.get('/changelog', (req, res) => {
  const rows = db.prepare('SELECT * FROM changelog').all();
  rows.sort((a, b) => {
    const pa = a.version.replace(/^v/, '').split('.').map(Number);
    const pb = b.version.replace(/^v/, '').split('.').map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const na = pa[i] || 0, nb = pb[i] || 0;
      if (na !== nb) return nb - na;
    }
    return 0;
  });
  res.json(rows.map(r => ({ ...r, changes: JSON.parse(r.changes) })));
});

router.post('/changelog', (req, res) => {
  const { version, title, changes } = req.body;
  if (!version || !title || !changes) {
    return res.status(400).json({ error: 'version, title, changes обязательны' });
  }

  const result = db.prepare(
    'INSERT INTO changelog (version, title, changes) VALUES (?, ?, ?)'
  ).run(version, title, JSON.stringify(Array.isArray(changes) ? changes : [changes]));

  res.json({ id: result.lastInsertRowid });
});

router.put('/changelog/:id', (req, res) => {
  const entry = db.prepare('SELECT * FROM changelog WHERE id = ?').get(req.params.id);
  if (!entry) return res.status(404).json({ error: 'Not found' });

  const { version, title, changes } = req.body;
  db.prepare('UPDATE changelog SET version=?, title=?, changes=? WHERE id=?').run(
    version || entry.version,
    title || entry.title,
    changes ? JSON.stringify(Array.isArray(changes) ? changes : [changes]) : entry.changes,
    req.params.id
  );
  res.json({ ok: true });
});

router.delete('/changelog/:id', (req, res) => {
  db.prepare('DELETE FROM changelog WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ═══════════════════════════════════════════════════════════
// CUSTOMERS VIEW (admin)
// ═══════════════════════════════════════════════════════════

router.get('/customers', (req, res) => {
  const customers = db.prepare(
    `SELECT id, email, email_verified, telegram_id, telegram_username, name, balance, status, created_at, last_login_at
     FROM customers ORDER BY created_at DESC`
  ).all();
  res.json(customers);
});

router.get('/customers/:id', (req, res) => {
  const customer = db.prepare(
    'SELECT id, email, email_verified, telegram_id, telegram_username, name, balance, status, created_at, last_login_at FROM customers WHERE id = ?'
  ).get(req.params.id);
  if (!customer) return res.status(404).json({ error: 'Not found' });

  const orders = db.prepare('SELECT * FROM orders WHERE customer_id = ? ORDER BY created_at DESC').all(req.params.id);
  const payments = db.prepare('SELECT * FROM payments WHERE customer_id = ? ORDER BY created_at DESC').all(req.params.id);

  res.json({ ...customer, orders, payments });
});

router.put('/customers/:id/status', (req, res) => {
  const { status } = req.body; // 'active' or 'banned'
  if (!['active', 'banned'].includes(status)) return res.status(400).json({ error: 'Статус: active или banned' });
  db.prepare('UPDATE customers SET status = ? WHERE id = ?').run(status, req.params.id);
  res.json({ ok: true });
});

router.put('/customers/:id', (req, res) => {
  const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(req.params.id);
  if (!customer) return res.status(404).json({ error: 'Not found' });
  const { name, email, balance, status } = req.body;
  db.prepare('UPDATE customers SET name=?, email=?, balance=?, status=? WHERE id=?').run(
    name !== undefined ? name : customer.name,
    email !== undefined ? email : customer.email,
    balance !== undefined ? balance : customer.balance,
    status || customer.status,
    req.params.id
  );
  res.json({ ok: true });
});

router.delete('/customers/:id', (req, res) => {
  db.prepare('DELETE FROM payments WHERE customer_id = ?').run(req.params.id);
  db.prepare('DELETE FROM orders WHERE customer_id = ?').run(req.params.id);
  db.prepare('DELETE FROM customer_changelog_seen WHERE customer_id = ?').run(req.params.id);
  db.prepare('DELETE FROM sessions WHERE customer_id = ?').run(req.params.id);
  db.prepare('DELETE FROM customers WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// Create proxy for customer (admin)
router.post('/customers/:id/create-proxy', async (req, res) => {
  const { node_id, plan_id, period } = req.body;
  if (!node_id) return res.status(400).json({ error: 'node_id обязателен' });

  const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(req.params.id);
  if (!customer) return res.status(404).json({ error: 'Клиент не найден' });

  const node = db.prepare('SELECT * FROM nodes WHERE id = ?').get(node_id);
  if (!node) return res.status(404).json({ error: 'Нода не найдена' });

  const plan = plan_id ? db.prepare('SELECT * FROM plans WHERE id = ?').get(plan_id) : null;
  const usePeriod = period || (plan ? plan.period : 'monthly');

  try {
    // Create order
    const orderResult = db.prepare(
      `INSERT INTO orders (customer_id, plan_id, status, config, price, currency, period)
       VALUES (?, ?, 'pending', '{}', ?, ?, ?)`
    ).run(customer.id, plan_id || null, plan ? plan.price : 0, plan ? plan.currency : 'RUB', usePeriod);
    const orderId = orderResult.lastInsertRowid;

    // Generate unique username
    const userName = `c${customer.id}_${orderId}`;

    // Create proxy via SSH
    const { port, secret } = await ssh.createRemoteUser(node, userName);

    // Calculate expiry
    let expiresAt = new Date();
    if (usePeriod === 'daily') expiresAt.setDate(expiresAt.getDate() + 1);
    else if (usePeriod === 'yearly') expiresAt.setFullYear(expiresAt.getFullYear() + 1);
    else expiresAt.setMonth(expiresAt.getMonth() + 1);

    // Insert into users table
    db.prepare(
      `INSERT INTO users (node_id, name, port, secret, status, max_devices, expires_at)
       VALUES (?, ?, ?, ?, 'active', ?, ?)`
    ).run(node.id, userName, port, secret, plan ? plan.max_devices : 3, expiresAt.toISOString());

    // Update order to active
    db.prepare(
      `UPDATE orders SET status = 'active', node_id = ?, user_name = ?,
       paid_at = datetime('now'), expires_at = ? WHERE id = ?`
    ).run(node.id, userName, expiresAt.toISOString(), orderId);

    res.json({
      ok: true,
      order_id: orderId,
      user_name: userName,
      port, secret,
      link: `tg://proxy?server=${node.host}&port=${port}&secret=${secret}`,
      expires_at: expiresAt.toISOString(),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Delete proxy from order (admin)
router.delete('/customers/:customerId/orders/:orderId/proxy', async (req, res) => {
  const order = db.prepare(
    'SELECT * FROM orders WHERE id = ? AND customer_id = ?'
  ).get(req.params.orderId, req.params.customerId);
  if (!order) return res.status(404).json({ error: 'Заказ не найден' });

  try {
    if (order.node_id && order.user_name) {
      const node = db.prepare('SELECT * FROM nodes WHERE id = ?').get(order.node_id);
      if (node) {
        try { await ssh.removeRemoteUser(node, order.user_name); } catch (e) {
          console.error(`Failed to remove proxy ${order.user_name}:`, e.message);
        }
      }
      db.prepare('DELETE FROM users WHERE node_id = ? AND name = ?').run(order.node_id, order.user_name);
    }
    db.prepare("UPDATE orders SET status = 'cancelled', node_id = NULL, user_name = NULL WHERE id = ?").run(order.id);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Cancel / delete order (admin)
router.put('/orders/:id/status', (req, res) => {
  const { status } = req.body;
  if (!['active', 'cancelled', 'pending', 'expired'].includes(status)) {
    return res.status(400).json({ error: 'Недопустимый статус' });
  }
  db.prepare('UPDATE orders SET status = ? WHERE id = ?').run(status, req.params.id);
  res.json({ ok: true });
});

router.delete('/orders/:id', (req, res) => {
  db.prepare('DELETE FROM payments WHERE order_id = ?').run(req.params.id);
  db.prepare('DELETE FROM orders WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ═══════════════════════════════════════════════════════════
// ORDERS VIEW (admin)
// ═══════════════════════════════════════════════════════════

router.get('/orders', (req, res) => {
  const orders = db.prepare(
    `SELECT o.*, c.email as customer_email, c.name as customer_name, p.name as plan_name
     FROM orders o
     LEFT JOIN customers c ON o.customer_id = c.id
     LEFT JOIN plans p ON o.plan_id = p.id
     ORDER BY o.created_at DESC`
  ).all();
  res.json(orders);
});

// ═══════════════════════════════════════════════════════════
// PAYMENTS (admin)
// ═══════════════════════════════════════════════════════════

router.get('/payments', (req, res) => {
  const payments = db.prepare(
    `SELECT p.*, c.email, c.telegram_username FROM payments p
     LEFT JOIN customers c ON p.customer_id = c.id
     ORDER BY p.created_at DESC`
  ).all();
  res.json(payments);
});

router.post('/payments/:id/check', async (req, res) => {
  const payment = db.prepare('SELECT * FROM payments WHERE id = ?').get(req.params.id);
  if (!payment) return res.status(404).json({ error: 'Платёж не найден' });
  if (payment.status !== 'pending') return res.json({ status: payment.status, changed: false });

  try {
    const ykPayment = await yookassa.getPayment(payment.yookassa_payment_id);

    if (ykPayment.status === 'succeeded') {
      db.prepare(
        "UPDATE payments SET status = 'succeeded', method = ?, confirmed_at = datetime('now') WHERE id = ?"
      ).run(ykPayment.payment_method?.type || 'unknown', payment.id);

      const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(payment.order_id);
      if (order && order.status === 'pending') {
        // activateOrder is in client routes, but we can update status here
        db.prepare("UPDATE orders SET status = 'active', paid_at = datetime('now') WHERE id = ?").run(order.id);
      }
      res.json({ status: 'succeeded', changed: true });
    } else if (ykPayment.status === 'canceled') {
      db.prepare("UPDATE payments SET status = 'cancelled' WHERE id = ?").run(payment.id);
      res.json({ status: 'cancelled', changed: true });
    } else {
      res.json({ status: payment.status, changed: false });
    }
  } catch (e) {
    console.error(`Admin payment check error #${payment.id}:`, e.message);
    res.status(500).json({ error: 'Ошибка проверки: ' + e.message });
  }
});

// ═══════════════════════════════════════════════════════════
// DATABASE OPTIMIZATION (admin)
// ═══════════════════════════════════════════════════════════

router.get('/db/stats', (req, res) => {
  const tables = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
  ).all().map(t => {
    const count = db.prepare(`SELECT COUNT(*) as c FROM ${t.name}`).get();
    return { name: t.name, rows: count.c };
  });
  const sizeResult = db.prepare('SELECT page_count * page_size as size FROM pragma_page_count(), pragma_page_size()').get();
  res.json({ tables, size_bytes: sizeResult?.size || 0 });
});

router.post('/db/optimize', (req, res) => {
  const results = [];
  try {
    db.exec('VACUUM');
    results.push('VACUUM выполнен');
  } catch (e) { results.push('VACUUM ошибка: ' + e.message); }
  try {
    db.pragma('optimize');
    results.push('OPTIMIZE выполнен');
  } catch (e) { results.push('OPTIMIZE ошибка: ' + e.message); }
  try {
    db.pragma('integrity_check');
    results.push('Проверка целостности: OK');
  } catch (e) { results.push('Целостность: ' + e.message); }
  res.json({ results });
});

router.post('/db/cleanup', (req, res) => {
  const results = [];
  // Clean expired sessions
  const sessions = db.prepare("DELETE FROM sessions WHERE expires_at < datetime('now')").run();
  results.push(`Сессии: удалено ${sessions.changes}`);
  // Clean old connection history (>30 days)
  const hist = db.prepare("DELETE FROM connections_history WHERE recorded_at < datetime('now', '-30 days')").run();
  results.push(`История подключений: удалено ${hist.changes}`);
  // Clean orphaned changelog_seen
  const seen = db.prepare('DELETE FROM customer_changelog_seen WHERE customer_id NOT IN (SELECT id FROM customers)').run();
  results.push(`Changelog seen: удалено ${seen.changes}`);
  res.json({ results });
});

// ═══════════════════════════════════════════════════════════
// ANNOUNCEMENTS (admin)
// ═══════════════════════════════════════════════════════════

router.get('/announcements', (req, res) => {
  res.json(db.prepare('SELECT * FROM announcements ORDER BY created_at DESC').all());
});

router.post('/announcements', (req, res) => {
  const { title, message, type } = req.body;
  if (!title || !message) return res.status(400).json({ error: 'title и message обязательны' });
  const result = db.prepare(
    'INSERT INTO announcements (title, message, type) VALUES (?, ?, ?)'
  ).run(title, message, type || 'info');
  res.json({ id: result.lastInsertRowid });
});

router.put('/announcements/:id', (req, res) => {
  const { title, message, type, is_active } = req.body;
  const a = db.prepare('SELECT * FROM announcements WHERE id = ?').get(req.params.id);
  if (!a) return res.status(404).json({ error: 'Not found' });
  db.prepare('UPDATE announcements SET title=?, message=?, type=?, is_active=? WHERE id=?').run(
    title || a.title, message || a.message, type || a.type,
    is_active !== undefined ? is_active : a.is_active, req.params.id
  );
  res.json({ ok: true });
});

router.delete('/announcements/:id', (req, res) => {
  db.prepare('DELETE FROM announcements WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

module.exports = router;
