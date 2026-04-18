const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DATA_DIR = process.env.DATA_DIR || '/data';
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'mtg-panel.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS nodes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    host TEXT NOT NULL,
    domain TEXT,
    ssh_user TEXT DEFAULT 'root',
    ssh_port INTEGER DEFAULT 22,
    ssh_key TEXT,
    ssh_password TEXT,
    base_dir TEXT DEFAULT '/opt/mtg/users',
    start_port INTEGER DEFAULT 4433,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    node_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    port INTEGER NOT NULL,
    secret TEXT NOT NULL,
    status TEXT DEFAULT 'active',
    note TEXT DEFAULT '',
    expires_at DATETIME DEFAULT NULL,
    traffic_limit_gb REAL DEFAULT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (node_id) REFERENCES nodes(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS connections_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    node_id INTEGER NOT NULL,
    user_name TEXT NOT NULL,
    connections INTEGER DEFAULT 0,
    recorded_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );
`);

// ── Client-facing tables (Proxy Store) ────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS customers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT,
    email_verified INTEGER DEFAULT 0,
    email_verify_token TEXT,
    email_verify_expires DATETIME,
    password_hash TEXT,
    telegram_id TEXT UNIQUE,
    telegram_username TEXT,
    name TEXT,
    balance REAL DEFAULT 0,
    status TEXT DEFAULT 'active',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_login_at DATETIME
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_customers_email ON customers(email) WHERE email IS NOT NULL;

  CREATE TABLE IF NOT EXISTS plans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT,
    price REAL NOT NULL,
    currency TEXT DEFAULT 'RUB',
    period TEXT DEFAULT 'monthly',
    max_devices INTEGER DEFAULT 3,
    traffic_limit_gb REAL,
    traffic_reset_interval TEXT DEFAULT 'monthly',
    location_ids TEXT DEFAULT '[]',
    is_active INTEGER DEFAULT 1,
    sort_order INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id INTEGER NOT NULL,
    plan_id INTEGER,
    node_id INTEGER,
    user_name TEXT,
    status TEXT DEFAULT 'pending',
    config TEXT,
    price REAL NOT NULL,
    currency TEXT DEFAULT 'RUB',
    period TEXT DEFAULT 'monthly',
    auto_renew INTEGER DEFAULT 0,
    paid_at DATETIME,
    expires_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (customer_id) REFERENCES customers(id),
    FOREIGN KEY (plan_id) REFERENCES plans(id),
    FOREIGN KEY (node_id) REFERENCES nodes(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id INTEGER NOT NULL,
    order_id INTEGER,
    yookassa_payment_id TEXT UNIQUE,
    amount REAL NOT NULL,
    currency TEXT DEFAULT 'RUB',
    status TEXT DEFAULT 'pending',
    method TEXT,
    description TEXT,
    metadata TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    confirmed_at DATETIME,
    FOREIGN KEY (customer_id) REFERENCES customers(id),
    FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id INTEGER NOT NULL,
    refresh_token_hash TEXT NOT NULL,
    ip TEXT,
    user_agent TEXT,
    expires_at DATETIME NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS changelog (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    version TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    changes TEXT NOT NULL,
    released_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS customer_changelog_seen (
    customer_id INTEGER NOT NULL,
    version TEXT NOT NULL,
    seen_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (customer_id, version),
    FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE
  );
`);

// Seed initial changelog v0.01
try {
  const exists = db.prepare('SELECT id FROM changelog WHERE version = ?').get('0.01');
  if (!exists) {
    db.prepare('INSERT INTO changelog (version, title, changes) VALUES (?, ?, ?)').run(
      '0.01', 'Первый релиз', JSON.stringify([
        'Личный кабинет с регистрацией и авторизацией',
        'Подтверждение Email при регистрации',
        'Авторизация через Telegram',
        'Привязка Email из профиля для Telegram-пользователей',
        'Каталог тарифных планов',
        'Покупка прокси с выбором локации',
        'Оплата через ЮКассу (карты, ЮMoney, СБП)',
        'Автопродление подписки (вкл/выкл)',
        'Мониторинг подключений в реальном времени',
        'История платежей',
        'Email-уведомления (чеки, напоминания)',
        'QR-код и ссылка для быстрого подключения',
        'Тёмная тема интерфейса',
        'Система версионности с changelog',
      ])
    );
  }
  const exists003 = db.prepare('SELECT id FROM changelog WHERE version = ?').get('0.0.3');
  if (!exists003) {
    db.prepare('INSERT INTO changelog (version, title, changes) VALUES (?, ?, ?)').run(
      '0.0.3', 'Обновление', JSON.stringify([
        'Управление тарифами через панель администратора',
        'Авторизация через Telegram на страницах входа и регистрации',
        'Подвал сайта со ссылками на оферту и политику конфиденциальности',
        'Страница публичной оферты',
        'Страница политики конфиденциальности',
        'Исправлено отображение периода тарифа',
      ])
    );
  }
  const exists200 = db.prepare('SELECT id FROM changelog WHERE version = ?').get('2.0.0');
  if (!exists200) {
    db.prepare('INSERT INTO changelog (version, title, changes) VALUES (?, ?, ?)').run(
      '2.0.0', 'Крупное обновление', JSON.stringify([
        'Страница результата оплаты (успех / ожидание / ошибка)',
        'Отвязка Telegram из профиля',
        'Страница «История обновлений» вместо модального окна',
        'Уведомления от администратора на дашборде',
        'Красивый футер на лендинге и в дашборде',
        'Динамическое отображение версии из API',
        'Управление базой данных в админ-панели (оптимизация, очистка)',
        'Управление уведомлениями для клиентов в админ-панели',
        'Автоматическая проверка статуса платежей',
        'Кнопка ручной проверки платежа',
        'Ребрендинг: ST VILLAGE PROXY',
        'Исправлен баг с прокси-ссылкой (xxd)',
        'Привязка Email / Telegram из профиля',
      ])
    );
  }
} catch (_) {}

// Migrate existing tables if needed
try { db.exec("ALTER TABLE users ADD COLUMN note TEXT DEFAULT ''"); } catch {}
try { db.exec("ALTER TABLE users ADD COLUMN expires_at DATETIME DEFAULT NULL"); } catch {}
try { db.exec("ALTER TABLE users ADD COLUMN traffic_limit_gb REAL DEFAULT NULL"); } catch {}
try { db.exec("ALTER TABLE users ADD COLUMN max_devices INTEGER DEFAULT 3"); } catch {}
try { db.exec("ALTER TABLE users ADD COLUMN traffic_reset_interval TEXT DEFAULT 'monthly'"); } catch {}
try { db.exec("ALTER TABLE users ADD COLUMN next_reset_at DATETIME DEFAULT NULL"); } catch {}
try { db.exec("ALTER TABLE nodes ADD COLUMN domain TEXT"); } catch {}
try { db.exec("ALTER TABLE nodes ADD COLUMN flag TEXT DEFAULT '🌍'"); } catch {}
try { db.exec("ALTER TABLE nodes ADD COLUMN agent_port INTEGER DEFAULT NULL"); } catch {}

// ── Announcements ─────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS announcements (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    message TEXT NOT NULL,
    type TEXT DEFAULT 'info',
    is_active INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// ── Admin users (roles) ───────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS admin_users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'support',
    display_name TEXT,
    status TEXT DEFAULT 'active',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_login_at DATETIME
  );
`);

module.exports = db;
