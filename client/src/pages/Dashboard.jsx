import { useEffect, useState, useCallback, useRef } from 'react';
import { Link } from 'react-router-dom';
import { ordersApi, proxiesApi, paymentsApi, profileApi, balanceApi, vpnApi } from '../api/client';
import { Wifi, CreditCard, Activity, ArrowRight, Globe, Clock, Shield, BarChart3, Zap, TrendingUp, CalendarDays, RefreshCw, Wallet, Plus, X, Gift } from 'lucide-react';
import Spinner from '../components/ui/Spinner';
import { useToast } from '../components/ui/Toast';
import {
  Chart as ChartJS,
  CategoryScale, LinearScale, PointElement, LineElement,
  BarElement, ArcElement,
  Tooltip, Filler, Legend
} from 'chart.js';
import { Line, Doughnut } from 'react-chartjs-2';

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, BarElement, ArcElement, Tooltip, Filler, Legend);

export default function Dashboard() {
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [proxyStats, setProxyStats] = useState({});
  const [proxyPings, setProxyPings] = useState({});
  const [lastUpdate, setLastUpdate] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [balance, setBalance] = useState(0);
  const [showTopup, setShowTopup] = useState(false);
  const [topupAmount, setTopupAmount] = useState('');
  const [topupLoading, setTopupLoading] = useState(false);
  const [vpnStatus, setVpnStatus] = useState(null);
  const intervalRef = useRef(null);
  const toast = useToast();

  const fetchData = useCallback((silent = false) => {
    if (!silent) setRefreshing(true);
    return Promise.all([
      ordersApi.list().catch(() => ({ data: [] })),
      proxiesApi.list().catch(() => ({ data: [] })),
      paymentsApi.list().catch(() => ({ data: [] })),
      profileApi.get().catch(() => ({ data: {} })),
      balanceApi.get().catch(() => ({ data: { balance: 0 } })),
    ]).then(([orders, proxies, payments, profile, bal]) => {
      setBalance(bal.data?.balance || 0);
      const allOrders = orders.data || [];
      const active = allOrders.filter(o => o.status === 'active');
      const pending = allOrders.filter(o => o.status === 'pending');
      const allPayments = payments.data || [];
      const paid = allPayments.filter(p => p.status === 'succeeded');
      const totalSpent = paid.reduce((s, p) => s + Number(p.amount), 0);
      const proxyList = proxies.data || [];

      // Payment history by month (last 6 months)
      const monthlySpend = {};
      const now = new Date();
      for (let i = 5; i >= 0; i--) {
        const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
        const key = d.toLocaleDateString('ru', { month: 'short' });
        monthlySpend[key] = 0;
      }
      paid.forEach(p => {
        const d = new Date(p.created_at || p.confirmed_at);
        const key = d.toLocaleDateString('ru', { month: 'short' });
        if (monthlySpend[key] !== undefined) monthlySpend[key] += Number(p.amount);
      });

      // Order status distribution
      const statusCounts = { active: 0, pending: 0, cancelled: 0, expired: 0 };
      allOrders.forEach(o => {
        if (o.status === 'cancelled' || o.status === 'canceled') statusCounts.cancelled++;
        else if (statusCounts[o.status] !== undefined) statusCounts[o.status]++;
        else statusCounts.expired++;
      });

      setStats({
        activeProxies: active.length,
        pendingOrders: pending.length,
        totalOrders: allOrders.length,
        totalSpent,
        avgOrderPrice: paid.length ? Math.round(totalSpent / paid.length) : 0,
        recentPayments: allPayments.slice(0, 5),
        proxies: proxyList.slice(0, 6),
        monthlyLabels: Object.keys(monthlySpend),
        monthlyData: Object.values(monthlySpend),
        statusCounts,
        profile: profile.data || {},
        nextExpiry: active.length ? active.reduce((min, o) =>
          !min || new Date(o.expires_at) < new Date(min) ? o.expires_at : min, null
        ) : null,
        daysUntilExpiry: active.length ? (() => {
          const nearest = active.reduce((min, o) =>
            !min || new Date(o.expires_at) < new Date(min) ? o.expires_at : min, null);
          return nearest ? Math.max(0, Math.ceil((new Date(nearest) - Date.now()) / 86400000)) : null;
        })() : null,
      });

      setLastUpdate(new Date());

      // Fetch live stats and ping for each proxy
      proxyList.forEach(p => {
        if (p.order_id) {
          proxiesApi.stats(p.order_id).then(({ data }) => {
            setProxyStats(prev => ({ ...prev, [p.order_id]: data }));
          }).catch(() => {});
          proxiesApi.ping(p.order_id).then(({ data }) => {
            setProxyPings(prev => ({ ...prev, [p.order_id]: data.ping }));
          }).catch(() => {});
        }
      });
    }).finally(() => {
      setLoading(false);
      setRefreshing(false);
    });
  }, []);

  const handleTopup = async () => {
    const amount = Number(topupAmount);
    if (!amount || amount < 1) { toast.error('Минимум 1 ₽'); return; }
    setTopupLoading(true);
    try {
      const { data } = await balanceApi.topup(amount);
      if (data.confirmation_url) {
        window.location.href = data.confirmation_url;
      } else {
        toast.error('Не удалось создать платёж');
      }
    } catch (err) {
      toast.error(err.response?.data?.error || 'Ошибка');
    } finally { setTopupLoading(false); }
  };

  useEffect(() => {
    fetchData();
    vpnApi.status().then(r => setVpnStatus(r.data || null)).catch(() => {});
    intervalRef.current = setInterval(() => fetchData(true), 30000);
    return () => clearInterval(intervalRef.current);
  }, [fetchData]);

  if (loading) return <div className="flex justify-center py-20"><Spinner size="lg" /></div>;

  const s = stats;

  const spendChartConfig = {
    labels: s.monthlyLabels,
    datasets: [{
      data: s.monthlyData,
      borderColor: '#7c6ff7',
      backgroundColor: 'rgba(124,111,247,0.15)',
      fill: true, tension: 0.4, pointRadius: 4, pointBackgroundColor: '#7c6ff7',
      borderWidth: 2,
    }],
  };

  const spendChartOpts = {
    responsive: true, maintainAspectRatio: false,
    plugins: { legend: { display: false }, tooltip: {
      callbacks: { label: (ctx) => `${ctx.raw.toLocaleString()} ₽` }
    }},
    scales: {
      x: { ticks: { color: '#6b7280', font: { size: 11 } }, grid: { display: false } },
      y: { display: false, beginAtZero: true },
    },
  };

  const hasOrders = s.totalOrders > 0;
  const statusChart = hasOrders ? {
    labels: ['Активные', 'Ожидают', 'Отменённые', 'Истёкшие'],
    datasets: [{
      data: [s.statusCounts.active, s.statusCounts.pending, s.statusCounts.cancelled, s.statusCounts.expired],
      backgroundColor: ['#34d399', '#fbbf24', '#fb7185', '#7c6ff7'],
      borderWidth: 0,
    }],
  } : null;

  const statusChartOpts = {
    responsive: true, maintainAspectRatio: false, cutout: '65%',
    plugins: { legend: { position: 'bottom', labels: { color: '#9ca3af', font: { size: 11 }, padding: 12, usePointStyle: true, pointStyleWidth: 8 } } },
  };

  const cards = [
    { icon: Wifi, label: 'Активных прокси', value: s.activeProxies, color: 'text-primary', bg: 'bg-primary/10' },
    { icon: CreditCard, label: 'Потрачено всего', value: `${s.totalSpent.toLocaleString()} ₽`, color: 'text-accent', bg: 'bg-accent/10' },
    { icon: Activity, label: 'Всего заказов', value: s.totalOrders, color: 'text-success', bg: 'bg-success/10' },
    { icon: Clock, label: 'До продления', value: s.daysUntilExpiry !== null ? `${s.daysUntilExpiry} дн.` : '—', color: 'text-warning', bg: 'bg-warning/10' },
  ];

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Дашборд</h1>
          <p className="text-gray-400 text-sm mt-0.5">
            {s.profile.name ? `Привет, ${s.profile.name}!` : 'Добро пожаловать!'}
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {lastUpdate && (
            <span className="text-xs text-gray-500 hidden sm:block">
              Обновлено: {lastUpdate.toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
            </span>
          )}
          <button onClick={() => fetchData()} disabled={refreshing}
            className="btn-secondary btn-sm flex items-center gap-1.5">
            <RefreshCw size={14} className={refreshing ? 'animate-spin' : ''} />
            <span className="hidden sm:inline">Обновить</span>
          </button>
          <Link to="/plans" className="btn-primary btn-sm flex items-center gap-1.5">
            <Zap size={14} /> Купить
          </Link>
        </div>
      </div>

      {/* Stat cards + Balance */}
      <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
        {cards.map(c => (
          <div key={c.label} className="card flex items-center gap-4">
            <div className={`w-10 h-10 rounded-xl ${c.bg} flex items-center justify-center shrink-0`}>
              <c.icon size={20} className={c.color} />
            </div>
            <div className="min-w-0">
              <p className="text-xs text-gray-400">{c.label}</p>
              <p className="text-lg font-bold truncate">{c.value}</p>
            </div>
          </div>
        ))}

        {/* Balance card */}
        <div className="card col-span-2 lg:col-span-2 relative overflow-hidden"
          style={{background: 'linear-gradient(135deg, rgba(124,111,247,0.15), rgba(99,102,241,0.08))'}}>
          <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 sm:gap-4">
            <div className="flex items-center gap-3 sm:gap-4 min-w-0">
              <div className="w-10 h-10 sm:w-12 sm:h-12 rounded-xl bg-primary/20 flex items-center justify-center shrink-0">
                <Wallet size={20} className="text-primary sm:hidden" />
                <Wallet size={24} className="text-primary hidden sm:block" />
              </div>
              <div className="min-w-0">
                <p className="text-xs text-gray-400">Баланс</p>
                <p className="text-xl sm:text-2xl font-black gradient-text">{balance.toFixed(2)} ₽</p>
                <p className="text-[11px] text-gray-500 mt-0.5 hidden sm:block">Используется для автопродления прокси</p>
              </div>
            </div>
            <button onClick={() => { setShowTopup(true); setTopupAmount(''); }}
              className="btn-primary btn-sm flex items-center gap-1.5 w-full sm:w-auto justify-center">
              <Plus size={14} /> Пополнить
            </button>
          </div>
        </div>
      </div>

      {/* VPN Free Proxy Block */}
      {vpnStatus?.enabled && (
        vpnStatus.hasVpn ? (
          vpnStatus.hasFreeProxy ? (
            <div className="card border border-emerald-500/20 bg-emerald-500/5">
              <div className="flex flex-col sm:flex-row items-start sm:items-center gap-3 sm:gap-4">
                <div className="w-10 h-10 rounded-xl bg-emerald-500/20 flex items-center justify-center shrink-0">
                  <Gift size={20} className="text-emerald-400" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="font-semibold text-emerald-400">Бесплатный прокси по VPN активен</p>
                  <p className="text-xs text-gray-500 mt-0.5">
                    Действует пока активна подписка VPN ST VILLAGE
                    {vpnStatus.vpnExpiresAt && ` · до ${new Date(vpnStatus.vpnExpiresAt).toLocaleDateString('ru-RU')}`}
                  </p>
                </div>
                <Link to="/proxies" className="btn-secondary btn-sm flex items-center gap-1.5 shrink-0 w-full sm:w-auto justify-center">
                  Перейти <ArrowRight size={14} />
                </Link>
              </div>
            </div>
          ) : (
            <div className="card border border-emerald-500/30 bg-gradient-to-r from-emerald-500/10 to-emerald-600/5">
              <div className="flex flex-col sm:flex-row items-start sm:items-center gap-3 sm:gap-4">
                <div className="w-12 h-12 rounded-xl bg-emerald-500/20 flex items-center justify-center shrink-0">
                  <Gift size={24} className="text-emerald-400" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="font-bold text-emerald-400">У вас есть бесплатный прокси!</p>
                  <p className="text-sm text-gray-400 mt-0.5">Ваша VPN ST VILLAGE подписка даёт бесплатный Telegram-прокси. Активируйте его прямо сейчас.</p>
                </div>
                <Link to="/plans" className="flex items-center justify-center gap-2 px-5 py-2.5 rounded-xl font-semibold text-white bg-gradient-to-r from-emerald-600 to-emerald-500 hover:from-emerald-500 hover:to-emerald-400 transition text-sm shrink-0 w-full sm:w-auto">
                  <Gift size={14} /> Получить
                </Link>
              </div>
            </div>
          )
        ) : (
          <div className="card border border-white/5 bg-gradient-to-r from-primary/5 to-accent/5">
            <div className="flex flex-col sm:flex-row items-start sm:items-center gap-3 sm:gap-4">
              <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center shrink-0">
                <Gift size={20} className="text-primary" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="font-semibold">Бесплатный прокси для подписчиков VPN</p>
                <p className="text-xs text-gray-500 mt-0.5">Оформите подписку на VPN ST VILLAGE и получите бесплатный Telegram-прокси</p>
              </div>
              <a href="https://cabinet.st-villagevpn.ru/" target="_blank" rel="noopener noreferrer"
                className="btn-secondary btn-sm flex items-center gap-1.5 shrink-0 w-full sm:w-auto justify-center">
                Подробнее <ArrowRight size={14} />
              </a>
            </div>
          </div>
        )
      )}

      {/* Topup modal */}
      {showTopup && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
          onClick={() => setShowTopup(false)}>
          <div className="bg-surface border border-white/10 rounded-2xl w-full max-w-sm p-6 space-y-5 animate-fade-in"
            onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-bold flex items-center gap-2">
                <Wallet size={20} className="text-primary" /> Пополнение баланса
              </h2>
              <button onClick={() => setShowTopup(false)}
                className="p-1.5 text-gray-500 hover:text-gray-300 transition rounded-lg hover:bg-white/10">
                <X size={18} />
              </button>
            </div>

            <div>
              <p className="text-sm text-gray-400 mb-3">Средства будут использоваться для автопродления прокси</p>
              <div className="flex flex-wrap gap-2 mb-3">
                {[100, 200, 500, 1000].map(v => (
                  <button key={v} onClick={() => setTopupAmount(String(v))}
                    className={`px-4 py-2 rounded-xl text-sm transition ${String(v) === topupAmount ? 'bg-primary text-white' : 'bg-surface-light text-gray-300 hover:bg-surface-lighter'}`}>
                    {v} ₽
                  </button>
                ))}
              </div>
              <input type="number" min="1" max="100000" placeholder="Или введите сумму..."
                value={topupAmount} onChange={e => setTopupAmount(e.target.value)}
                className="input w-full" />
            </div>

            <div className="flex gap-3">
              <button onClick={() => setShowTopup(false)} className="btn-secondary flex-1">Отмена</button>
              <button onClick={handleTopup} disabled={topupLoading || !topupAmount}
                className="btn-primary flex-1 flex items-center justify-center gap-2">
                {topupLoading ? <Spinner size="sm" /> : <><CreditCard size={16} /> Оплатить</>}
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="grid lg:grid-cols-3 gap-6">
        {/* Spending chart */}
        <div className="card lg:col-span-2">
          <div className="flex justify-between items-center mb-4">
            <h3 className="font-semibold flex items-center gap-2"><BarChart3 size={16} className="text-primary" /> Расходы за полгода</h3>
            <Link to="/payments" className="text-xs text-primary flex items-center gap-1 hover:underline">
              Все платежи <ArrowRight size={12} />
            </Link>
          </div>
          <div className="h-48">
            {s.monthlyData.some(v => v > 0) ? <Line data={spendChartConfig} options={spendChartOpts} /> : (
              <div className="flex items-center justify-center h-full text-gray-500 text-sm">Нет данных о расходах</div>
            )}
          </div>
        </div>

        {/* Order distribution */}
        <div className="card">
          <h3 className="font-semibold mb-4 flex items-center gap-2"><CalendarDays size={16} className="text-accent" /> Статусы заказов</h3>
          <div className="h-48">
            {statusChart ? <Doughnut data={statusChart} options={statusChartOpts} /> : (
              <div className="flex items-center justify-center h-full text-gray-500 text-sm">Нет заказов</div>
            )}
          </div>
        </div>
      </div>

      {/* Recent payments */}
      {s.recentPayments.length > 0 && (
        <div className="card">
          <div className="flex justify-between items-center mb-4">
            <h3 className="font-semibold">Последние платежи</h3>
            <Link to="/payments" className="text-xs text-primary flex items-center gap-1 hover:underline">
              Все <ArrowRight size={12} />
            </Link>
          </div>
          <div className="hidden sm:block overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-gray-500 border-b border-white/5">
                  <th className="pb-2 font-medium">Дата</th>
                  <th className="pb-2 font-medium">Сумма</th>
                  <th className="pb-2 font-medium">Статус</th>
                  <th className="pb-2 font-medium">Описание</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {s.recentPayments.map(p => (
                  <tr key={p.id} className="text-gray-300">
                    <td className="py-2 text-xs">{new Date(p.created_at).toLocaleDateString('ru')}</td>
                    <td className="py-2 font-semibold">{Number(p.amount).toLocaleString()} ₽</td>
                    <td className="py-2">
                      <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
                        p.status === 'succeeded' ? 'bg-success/10 text-success' :
                        p.status === 'pending' ? 'bg-warning/10 text-warning' : 'bg-danger/10 text-danger'
                      }`}>{p.status === 'succeeded' ? 'Оплачен' : p.status === 'pending' ? 'Ожидание' : 'Отменён'}</span>
                    </td>
                    <td className="py-2 text-xs text-gray-400">{p.description || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="sm:hidden space-y-3">
            {s.recentPayments.map(p => (
              <div key={p.id} className="bg-surface-light rounded-xl p-3 flex items-center justify-between">
                <div>
                  <p className="font-semibold text-sm">{Number(p.amount).toLocaleString()} ₽</p>
                  <p className="text-xs text-gray-500">{new Date(p.created_at).toLocaleDateString('ru')}</p>
                </div>
                <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
                  p.status === 'succeeded' ? 'bg-success/10 text-success' :
                  p.status === 'pending' ? 'bg-warning/10 text-warning' : 'bg-danger/10 text-danger'
                }`}>{p.status === 'succeeded' ? 'Оплачен' : p.status === 'pending' ? 'Ожидание' : 'Отменён'}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Quick actions */}
      <div className="grid sm:grid-cols-3 gap-4">
        <Link to="/plans" className="card hover:ring-1 hover:ring-primary/50 transition group">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center">
              <Zap size={18} className="text-primary" />
            </div>
            <div>
              <p className="font-semibold group-hover:text-primary transition">Купить прокси</p>
              <p className="text-xs text-gray-500">Выбрать тариф и локацию</p>
            </div>
          </div>
        </Link>
        <Link to="/payments" className="card hover:ring-1 hover:ring-accent/50 transition group">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-accent/10 flex items-center justify-center">
              <CreditCard size={18} className="text-accent" />
            </div>
            <div>
              <p className="font-semibold group-hover:text-accent transition">Платежи</p>
              <p className="text-xs text-gray-500">История всех операций</p>
            </div>
          </div>
        </Link>
        <Link to="/profile" className="card hover:ring-1 hover:ring-success/50 transition group">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-success/10 flex items-center justify-center">
              <Shield size={18} className="text-success" />
            </div>
            <div>
              <p className="font-semibold group-hover:text-success transition">Профиль</p>
              <p className="text-xs text-gray-500">Настройки аккаунта</p>
            </div>
          </div>
        </Link>
      </div>

      {/* Active proxies preview */}
      {s.proxies.length > 0 && (
        <div className="card">
          <div className="flex justify-between items-center mb-4">
            <h3 className="font-semibold">Ваши прокси</h3>
            <Link to="/proxies" className="text-xs text-primary flex items-center gap-1 hover:underline">
              Все <ArrowRight size={12} />
            </Link>
          </div>
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {s.proxies.map(p => {
              const live = proxyStats[p.order_id];
              const ping = proxyPings[p.order_id];
              const daysLeft = p.expires_at ? Math.max(0, Math.ceil((new Date(p.expires_at) - Date.now()) / 86400000)) : null;
              return (
                <Link to={`/proxies/${p.order_id}`} key={p.order_id}
                  className="bg-surface-light rounded-xl p-4 hover:bg-surface-lighter transition group">
                  <div className="flex items-center justify-between mb-3">
                    <span className="text-xl">{p.node_flag || <Globe size={18} />}</span>
                    <div className="flex items-center gap-2">
                      {ping !== undefined && (
                        <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                          ping < 0 ? 'bg-danger/10 text-danger' :
                          ping < 100 ? 'bg-success/10 text-success' :
                          ping < 200 ? 'bg-warning/10 text-warning' : 'bg-danger/10 text-danger'
                        }`}>{ping < 0 ? 'N/A' : `${ping} ms`}</span>
                      )}
                      <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                        live?.running ? 'bg-success/10 text-success' : 'bg-gray-500/10 text-gray-400'
                      }`}>{live?.running ? '● Онлайн' : '○ Офлайн'}</span>
                    </div>
                  </div>
                  <p className="text-sm font-semibold text-gray-200 group-hover:text-white transition truncate">
                    {p.plan_name || `Прокси #${p.order_id}`}
                  </p>
                  <div className="mt-2 flex items-center justify-between text-xs text-gray-500">
                    <span>{live ? `${live.connections} устр.` : '...'}</span>
                    <span>{daysLeft !== null ? `${daysLeft} дн.` : ''}</span>
                  </div>
                  {daysLeft !== null && (
                    <div className="mt-2 h-1 rounded-full bg-white/5 overflow-hidden">
                      <div className={`h-full rounded-full transition-all ${daysLeft <= 3 ? 'bg-danger' : daysLeft <= 7 ? 'bg-warning' : 'bg-primary'}`}
                        style={{ width: `${Math.min(100, (daysLeft / 30) * 100)}%` }} />
                    </div>
                  )}
                </Link>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
