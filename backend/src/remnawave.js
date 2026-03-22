/**
 * Remnawave VPN subscription checker.
 * Queries Remnawave API to verify if a customer has an active VPN subscription.
 *
 * Env variables:
 *   REMNAWAVE_API_URL   — base URL (e.g. https://vpn.example.com/api)
 *   REMNAWAVE_API_TOKEN — Bearer token for Remnawave API
 *   VPN_FREE_PLAN_ID    — plan ID in this panel to give for free to VPN subscribers
 */

const https = require('https');
const http = require('http');
const { URL } = require('url');

const API_URL = () => process.env.REMNAWAVE_API_URL || '';
const API_TOKEN = () => process.env.REMNAWAVE_API_TOKEN || '';
const FREE_PLAN_ID = () => {
  const v = process.env.VPN_FREE_PLAN_ID;
  return v ? Number(v) : null;
};

function isEnabled() {
  return !!(API_URL() && API_TOKEN() && FREE_PLAN_ID());
}

/**
 * Make a GET request to Remnawave API.
 * @param {string} path — API path (e.g. /users/by-telegram-id/12345)
 * @returns {Promise<object|null>}
 */
function apiGet(path) {
  const baseUrl = API_URL().replace(/\/+$/, '');
  const fullUrl = `${baseUrl}${path}`;
  let parsed;
  try {
    parsed = new URL(fullUrl);
  } catch {
    return Promise.resolve(null);
  }

  const mod = parsed.protocol === 'https:' ? https : http;

  return new Promise((resolve) => {
    const req = mod.get(
      {
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path: parsed.pathname + parsed.search,
        headers: {
          Authorization: `Bearer ${API_TOKEN()}`,
          Accept: 'application/json',
        },
        timeout: 10000,
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try {
              resolve(JSON.parse(data));
            } catch {
              resolve(null);
            }
          } else {
            resolve(null);
          }
        });
      }
    );
    req.on('error', () => resolve(null));
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
  });
}

/**
 * Check if a customer has an active VPN subscription in Remnawave.
 * Tries telegram_id first, then email as fallback.
 *
 * @param {{ telegram_id?: string, email?: string }} customer
 * @returns {Promise<{ hasVpn: boolean, expiresAt: Date|null }>}
 */
async function checkVpnSubscription(customer) {
  if (!isEnabled()) return { hasVpn: false, expiresAt: null };

  let userData = null;

  // Priority: telegram_id
  if (customer.telegram_id) {
    const resp = await apiGet(`/users/by-telegram-id/${encodeURIComponent(customer.telegram_id)}`);
    if (resp && resp.response) userData = resp.response;
  }

  // Fallback: email
  if (!userData && customer.email) {
    const resp = await apiGet(`/users/by-email/${encodeURIComponent(customer.email)}`);
    if (resp && resp.response) userData = resp.response;
  }

  if (!userData) return { hasVpn: false, expiresAt: null };

  const isActive = userData.status === 'ACTIVE';
  const expiresAt = userData.expireAt ? new Date(userData.expireAt) : null;
  const notExpired = expiresAt ? expiresAt > new Date() : false;

  return {
    hasVpn: isActive && notExpired,
    expiresAt: expiresAt,
  };
}

module.exports = { isEnabled, checkVpnSubscription, FREE_PLAN_ID };
