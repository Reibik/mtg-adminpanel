import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { ordersApi, proxiesApi } from '../api/client';
import { useToast } from '../components/ui/Toast';
import { QRCodeSVG } from 'qrcode.react';
import {
  Chart as ChartJS,
  CategoryScale, LinearScale, PointElement, LineElement,
  Tooltip, Filler
} from 'chart.js';
import { Line } from 'react-chartjs-2';
import {
  ArrowLeft, Copy, QrCode, Wifi, Clock,
  Users, ToggleLeft, ToggleRight, Download, Upload, Signal, RefreshCw
} from 'lucide-react';
import Spinner from '../components/ui/Spinner';

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Tooltip, Filler);

export default function ProxyDetail() {
  const { orderId } = useParams();
  const [order, setOrder] = useState(null);
  const [proxy, setProxy] = useState(null);
  const [stats, setStats] = useState(null);
  const [ping, setPing] = useState(null);
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(true);
  const [toggling, setToggling] = useState(false);
  const [renewLoading, setRenewLoading] = useState(false);
  const toast = useToast();

  const load = () => {
    Promise.all([
      ordersApi.get(orderId),
      proxiesApi.list(),
      proxiesApi.stats(orderId).catch(() => ({ data: null })),
      proxiesApi.history(orderId).catch(() => ({ data: [] })),
      proxiesApi.ping(orderId).catch(() => ({ data: { ping: -1 } })),
    ]).then(([o, pl, s, h, pg]) => {
      setOrder(o.data);
      const px = (pl.data || []).find(p => p.order_id === Number(orderId));
      setProxy(px || null);
      setStats(s.data);
      setHistory(h.data || []);
      setPing(pg.data?.ping ?? -1);
    }).catch(() => {
      toast.error('Не удалось загрузить данные прокси');
    }).finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, [orderId]);

  const handleAutoRenew = async () => {
    setToggling(true);
    try {
      const { data } = await ordersApi.toggleAutoRenew(orderId, !order.auto_renew);
      setOrder(prev => ({ ...prev, auto_renew: data.auto_renew }));
      toast.success(data.auto_renew ? 'Автопродление включено' : 'Автопродление выключено');
    } catch { toast.error('Ошибка'); }
    finally { setToggling(false); }
  };

  const copyLink = (text) => {
    navigator.clipboard.writeText(text);
    toast.success('Скопировано!');
  };

  if (loading) return <div className="flex justify-center py-20"><Spinner size="lg" /></div>;
  if (!order) return <div className="card text-center py-12"><p>Заказ не найден</p><Link to="/proxies" className="btn-primary mt-4">Назад</Link></div>;

  const tgLink = proxy?.link || null;
  const expires = order.expires_at ? new Date(order.expires_at) : null;
  const daysLeft = expires ? Math.ceil((expires - Date.now()) / 86400000) : 0;

  // Chart data from connection history
  const chartData = history.length > 0 ? {
    labels: history.map(h => {
      const d = new Date(h.recorded_at);
      return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
    }),
    datasets: [{
      label: 'Подключения',
      data: history.map(h => h.connections || 0),
      borderColor: '#7c6ff7',
      backgroundColor: 'rgba(124,111,247,0.1)',
      fill: true, tension: 0.4, pointRadius: 2,
    }],
  } : null;

  const chartOpts = {
    responsive: true, maintainAspectRatio: false,
    plugins: { legend: { display: false } },
    scales: {
      x: { ticks: { color: '#6b7280', font: { size: 10 } }, grid: { display: false } },
      y: { ticks: { color: '#6b7280' }, grid: { color: 'rgba(107,114,128,0.1)' }, beginAtZero: true },
    },
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3 flex-wrap">
        <Link to="/proxies" className="btn-secondary p-2"><ArrowLeft size={18} /></Link>
        <div className="flex-1 min-w-0">
          <h1 className="text-xl sm:text-2xl font-bold flex items-center gap-2">
            <span className="text-xl sm:text-2xl">{order.node_flag || '🌐'}</span>
            <span className="truncate">{order.plan_name || `Заказ #${order.id}`}</span>
          </h1>
          <p className="text-sm text-gray-400">ID: {order.id}</p>
        </div>
        <span className={`shrink-0 ${order.status === 'active' ? 'badge-success' : 'badge-danger'}`}>
          {order.status === 'active' ? 'Активен' : order.status}
        </span>
      </div>

      {/* Stats cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="card">
          <p className="text-xs text-gray-400 mb-1">Устройства онлайн</p>
          <p className="text-2xl font-bold flex items-center gap-2">
            <Users size={18} className="text-primary" /> {stats?.connections ?? 0}
          </p>
        </div>
        <div className="card">
          <p className="text-xs text-gray-400 mb-1">Трафик ↓</p>
          <p className="text-2xl font-bold flex items-center gap-2">
            <Download size={18} className="text-accent" /> {stats?.rx || '0B'}
          </p>
        </div>
        <div className="card">
          <p className="text-xs text-gray-400 mb-1">Трафик ↑</p>
          <p className="text-2xl font-bold flex items-center gap-2">
            <Upload size={18} className="text-success" /> {stats?.tx || '0B'}
          </p>
        </div>
        <div className="card">
          <p className="text-xs text-gray-400 mb-1">Истекает</p>
          <p className={`text-2xl font-bold flex items-center gap-2 ${daysLeft <= 3 ? 'text-warning' : ''}`}>
            <Clock size={18} /> {daysLeft > 0 ? `${daysLeft} дн.` : 'Скоро'}
          </p>
        </div>
      </div>

      {/* Connection status */}
      {proxy && (
        <div className="card flex items-center gap-4">
          <div className={`w-3 h-3 rounded-full ${stats?.running ? 'bg-success animate-pulse' : 'bg-gray-500'}`} />
          <div className="flex-1">
            <p className="font-semibold">{stats?.running ? 'Прокси онлайн' : 'Прокси офлайн'}</p>
            <p className="text-xs text-gray-400">Сервер: {proxy.node_name || proxy.node_host}</p>
          </div>
          {ping !== null && (
            <div className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium ${
              ping < 0 ? 'bg-danger/10 text-danger' :
              ping < 100 ? 'bg-success/10 text-success' :
              ping < 200 ? 'bg-warning/10 text-warning' : 'bg-danger/10 text-danger'
            }`}>
              <Signal size={14} />
              {ping < 0 ? 'Недоступен' : `${ping} ms`}
            </div>
          )}
        </div>
      )}

      {/* Connection */}
      {tgLink && (
        <div className="card">
          <h3 className="font-semibold mb-4 flex items-center gap-2"><QrCode size={18} className="text-primary" /> Подключение</h3>
          <div className="flex flex-col md:flex-row gap-6">
            <div className="bg-white p-4 rounded-xl self-start">
              <QRCodeSVG value={tgLink} size={160} />
            </div>
            <div className="flex-1 space-y-3">
              <div>
                <label className="text-xs text-gray-400 block mb-1">Ссылка для Telegram</label>
                <div className="flex gap-2">
                  <input readOnly value={tgLink} className="input flex-1 text-xs font-mono" />
                  <button onClick={() => copyLink(tgLink)} className="btn-secondary p-2"><Copy size={16} /></button>
                </div>
              </div>
              <a href={tgLink} target="_blank" rel="noopener noreferrer" className="btn-primary inline-flex items-center gap-2">
                <Wifi size={16} /> Открыть в Telegram
              </a>
            </div>
          </div>
        </div>
      )}

      {/* Chart */}
      {chartData && (
        <div className="card">
          <h3 className="font-semibold mb-4">История подключений (24ч)</h3>
          <div className="h-56">
            <Line data={chartData} options={chartOpts} />
          </div>
        </div>
      )}

      {/* Renew subscription */}
      {order.status === 'active' && (
        <div className="card">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="font-semibold flex items-center gap-2"><RefreshCw size={16} className="text-primary" /> Продлить подписку</h3>
              <p className="text-sm text-gray-400 mt-1">
                {daysLeft > 0 ? `Осталось ${daysLeft} дн. — продлите сейчас с баланса` : 'Подписка скоро истечёт — продлите сейчас'}
              </p>
            </div>
            <button onClick={async () => {
              setRenewLoading(true);
              try {
                const { data } = await ordersApi.renew(orderId);
                toast.success(`Подписка продлена! Новый баланс: ${Number(data.new_balance).toFixed(2)} ₽`);
                load();
              } catch (err) {
                toast.error(err.response?.data?.error || 'Ошибка при продлении');
              } finally { setRenewLoading(false); }
            }} disabled={renewLoading}
              className="btn-primary flex items-center gap-2 shrink-0">
              {renewLoading ? <Spinner size="sm" /> : <><RefreshCw size={16} /> Продлить</>}
            </button>
          </div>
        </div>
      )}

      {/* Auto-renew */}
      <div className="card flex items-center justify-between">
        <div>
          <h3 className="font-semibold">Автопродление</h3>
          <p className="text-sm text-gray-400">
            {order.auto_renew ? 'Подписка продлится автоматически' : 'Выключено — продлите вручную'}
          </p>
        </div>
        <button onClick={handleAutoRenew} disabled={toggling}
          className={`transition ${order.auto_renew ? 'text-primary' : 'text-gray-500'}`}>
          {toggling ? <Spinner size="sm" /> : (
            order.auto_renew
              ? <ToggleRight size={36} />
              : <ToggleLeft size={36} />
          )}
        </button>
      </div>
    </div>
  );
}
