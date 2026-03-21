import axios from 'axios';
import { useAuthStore } from '../store/auth';

const api = axios.create({
  baseURL: '/api/client',
  headers: { 'Content-Type': 'application/json' },
});

// Attach access token
api.interceptors.request.use(config => {
  const token = useAuthStore.getState().accessToken;
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

// Auto-refresh on 401
let isRefreshing = false;
let refreshQueue = [];

api.interceptors.response.use(
  res => res,
  async err => {
    const original = err.config;
    if (err.response?.status === 401 && !original._retry) {
      if (isRefreshing) {
        return new Promise((resolve, reject) => {
          refreshQueue.push({ resolve, reject });
        }).then(token => {
          original.headers.Authorization = `Bearer ${token}`;
          return api(original);
        });
      }

      original._retry = true;
      isRefreshing = true;

      try {
        const refreshToken = useAuthStore.getState().refreshToken;
        if (!refreshToken) throw new Error('No refresh token');

        const { data } = await axios.post('/api/client/auth/refresh', { refreshToken });
        useAuthStore.getState().setTokens(data.accessToken, data.refreshToken);

        refreshQueue.forEach(p => p.resolve(data.accessToken));
        refreshQueue = [];
        original.headers.Authorization = `Bearer ${data.accessToken}`;
        return api(original);
      } catch {
        refreshQueue.forEach(p => p.reject(err));
        refreshQueue = [];
        useAuthStore.getState().logout();
        window.location.href = '/login';
        return Promise.reject(err);
      } finally {
        isRefreshing = false;
      }
    }
    return Promise.reject(err);
  }
);

// ── Auth ──────────────────────────────────────────────────
export const authApi = {
  register: (data) => api.post('/auth/register', data),
  login: (data) => api.post('/auth/login', data),
  telegram: (data) => api.post('/auth/telegram', data),
  refresh: (data) => api.post('/auth/refresh', data),
  logout: (data) => api.post('/auth/logout', data),
  verifyEmail: (token) => api.get(`/auth/verify-email?token=${token}`),
  resendVerification: (data) => api.post('/auth/resend-verification', data),
  forgotPassword: (data) => api.post('/auth/forgot-password', data),
  resetPassword: (data) => api.post('/auth/reset-password', data),
};

// ── Profile ───────────────────────────────────────────────
export const profileApi = {
  get: () => api.get('/profile'),
  update: (data) => api.put('/profile', data),
  changePassword: (data) => api.put('/profile/password', data),
  linkEmail: (data) => api.post('/profile/link-email', data),
  verifyLinkEmail: (token) => api.get(`/profile/verify-link-email?token=${token}`),
  linkTelegram: (data) => api.post('/profile/link-telegram', data),
  unlinkTelegram: () => api.post('/profile/unlink-telegram'),
};

// ── Plans & Locations ─────────────────────────────────────
export const catalogApi = {
  plans: () => api.get('/plans'),
  locations: () => api.get('/locations'),
};

// ── Orders ────────────────────────────────────────────────
export const ordersApi = {
  list: () => api.get('/orders'),
  get: (id) => api.get(`/orders/${id}`),
  create: (data) => api.post('/orders', data),
  toggleAutoRenew: (id, enabled) => api.put(`/orders/${id}/auto-renew`, { enabled }),
  remove: (id) => api.delete(`/orders/${id}`),
  payWithBalance: (id) => api.post(`/orders/${id}/pay-balance`),
  renew: (id) => api.post(`/orders/${id}/renew`),
};

// ── Proxies ───────────────────────────────────────────────
export const proxiesApi = {
  list: () => api.get('/proxies'),
  stats: (orderId) => api.get(`/proxies/${orderId}/stats`),
  history: (orderId) => api.get(`/proxies/${orderId}/history`),
  ping: (orderId) => api.get(`/proxies/${orderId}/ping`),
};

// ── Balance ───────────────────────────────────────────────
export const balanceApi = {
  get: () => api.get('/balance'),
  topup: (amount) => api.post('/balance/topup', { amount }),
};

// ── Payments ──────────────────────────────────────────────
export const paymentsApi = {
  create: (data) => api.post('/payments/create', data),
  list: () => api.get('/payments'),
  check: (id) => api.post(`/payments/${id}/check`),
  retry: (id) => api.post(`/payments/${id}/retry`),
};

// ── Changelog ─────────────────────────────────────────────
export const changelogApi = {
  list: () => api.get('/changelog'),
  unseen: () => api.get('/changelog/unseen'),
  markSeen: (version) => api.post(`/changelog/${version}/seen`),
};

// ── Announcements ─────────────────────────────────────────

export const announcementsApi = {
  list: () => api.get('/announcements'),
};

export default api;
