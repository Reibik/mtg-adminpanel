/**
 * Модуль интеграции с API «Мой налог» (НПД / lknpd.nalog.ru)
 * Авто-отправка чеков самозанятого при получении оплаты
 * Поддержка HTTP/SOCKS5 прокси для серверов за рубежом
 */
const https = require('https');
const http = require('http');
const db = require('./db');

const API_BASE = 'https://lknpd.nalog.ru/api/v1';

// ── Хранилище токена ──────────────────────────────────────
let cachedToken = null;
let tokenExpiresAt = 0;

// ── Настройки из БД ───────────────────────────────────────
function getSetting(key) {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key);
  return row ? row.value : null;
}

function isEnabled() {
  return getSetting('npd_enabled') === '1';
}

function getCredentials() {
  const inn = getSetting('npd_inn');
  const password = getSetting('npd_password');
  return { inn, password };
}

// ── Proxy agent ───────────────────────────────────────────
function getProxyAgent() {
  const proxyUrl = getSetting('npd_proxy');
  if (!proxyUrl) return null;

  try {
    const url = new URL(proxyUrl);
    const proto = url.protocol.replace(':', '').toLowerCase();

    if (proto === 'socks5' || proto === 'socks5h' || proto === 'socks4') {
      const { SocksProxyAgent } = require('socks-proxy-agent');
      // socks5h = DNS resolution via proxy (critical for Docker / foreign servers)
      const fixedUrl = proto === 'socks5' ? proxyUrl.replace(/^socks5:/i, 'socks5h:') : proxyUrl;
      return new SocksProxyAgent(fixedUrl);
    }

    if (proto === 'http' || proto === 'https') {
      const { HttpsProxyAgent } = require('https-proxy-agent');
      return new HttpsProxyAgent(proxyUrl);
    }

    console.warn(`НПД: неизвестный протокол прокси: ${proto}`);
    return null;
  } catch (e) {
    console.error('НПД: ошибка создания proxy agent:', e.message);
    return null;
  }
}

// ── HTTP-запрос ───────────────────────────────────────────
function request(method, path, body, token) {
  return new Promise((resolve, reject) => {
    const url = new URL(API_BASE + path);
    const postData = body ? JSON.stringify(body) : null;
    const agent = getProxyAgent();

    const options = {
      hostname: url.hostname,
      port: 443,
      path: url.pathname + url.search,
      method,
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
        ...(postData ? { 'Content-Length': Buffer.byteLength(postData) } : {}),
      },
      ...(agent ? { agent } : {}),
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(parsed);
          } else {
            reject(new Error(`НПД API ${res.statusCode}: ${parsed.message || data}`));
          }
        } catch {
          reject(new Error(`НПД API: невалидный ответ (${res.statusCode})`));
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('НПД API: таймаут')); });

    if (postData) req.write(postData);
    req.end();
  });
}

// ── Авторизация ───────────────────────────────────────────
async function authenticate() {
  const { inn, password } = getCredentials();
  if (!inn || !password) throw new Error('НПД: не указаны ИНН или пароль');

  const result = await request('POST', '/auth/lkfl', {
    username: inn,
    password,
    deviceInfo: {
      sourceDeviceId: 'mtg-panel',
      sourceType: 'WEB',
      appVersion: '1.0.0',
      metaDetails: { userAgent: 'mtg-panel' },
    },
  });

  if (!result.token) throw new Error('НПД: не получен токен авторизации');

  cachedToken = result.token;
  // Токен живёт ~24ч, обновляем за час до
  tokenExpiresAt = Date.now() + 23 * 60 * 60 * 1000;

  return cachedToken;
}

async function getToken() {
  if (cachedToken && Date.now() < tokenExpiresAt) return cachedToken;
  return authenticate();
}

// ── Регистрация дохода (создание чека) ────────────────────
async function createReceipt({ amount, customerName, description, paymentDate }) {
  if (!isEnabled()) return null;

  const { inn } = getCredentials();
  if (!inn) throw new Error('НПД: не указан ИНН');

  const token = await getToken();

  const now = paymentDate ? new Date(paymentDate) : new Date();
  const operationTime = now.toISOString();

  const receiptData = {
    paymentType: 'CASH',
    ignoreMaxTotalIncomeRestriction: false,
    client: customerName ? { contactPhone: null, displayName: customerName, incomeType: 'FROM_INDIVIDUAL', inn: null } : undefined,
    requestTime: new Date().toISOString(),
    operationTime,
    services: [
      {
        name: description || 'Прокси-сервис',
        amount: parseFloat(amount),
        quantity: 1,
      },
    ],
    totalAmount: parseFloat(amount),
  };

  const result = await request('POST', '/income', receiptData, token);
  console.log(`🧾 НПД чек создан: ${result.approvedReceiptUuid || 'ok'}`);

  return {
    receiptId: result.approvedReceiptUuid,
    link: result.approvedReceiptUuid
      ? `https://lknpd.nalog.ru/api/v1/receipt/${inn}/${result.approvedReceiptUuid}/print`
      : null,
  };
}

// ── Отмена чека ───────────────────────────────────────────
async function cancelReceipt(receiptId, reason) {
  if (!receiptId) throw new Error('Не указан ID чека');

  const token = await getToken();

  await request('POST', `/cancel`, {
    receiptUuid: receiptId,
    comment: reason || 'Возврат',
    partnerCode: null,
    requestTime: new Date().toISOString(),
    operationTime: new Date().toISOString(),
  }, token);

  console.log(`🧾 НПД чек отменён: ${receiptId}`);
  return { ok: true };
}

// ── Тестовый запрос (проверка подключения) ────────────────
async function testConnection() {
  const token = await getToken();
  // Попробуем получить информацию о пользователе
  const result = await request('GET', '/user', null, token);
  return {
    ok: true,
    displayName: result.displayName || result.fio || 'OK',
    inn: result.inn,
  };
}

module.exports = {
  isEnabled,
  createReceipt,
  cancelReceipt,
  testConnection,
};
