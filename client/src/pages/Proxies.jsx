import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { proxiesApi, ordersApi } from '../api/client';
import { useToast } from '../components/ui/Toast';
import { Wifi, WifiOff, Globe, Clock, Users, ArrowRight, Trash2, X, AlertTriangle, RefreshCw, Pencil, Check } from 'lucide-react';
import Spinner from '../components/ui/Spinner';

export default function Proxies() {
  const [proxies, setProxies] = useState([]);
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const [renewing, setRenewing] = useState(null);
  const [renaming, setRenaming] = useState(null); // order id
  const [renameValue, setRenameValue] = useState('');
  const toast = useToast();

  const loadData = () => {
    return Promise.all([
      proxiesApi.list().catch(() => ({ data: [] })),
      ordersApi.list().catch(() => ({ data: [] })),
    ]).then(([p, o]) => {
      setProxies(p.data || []);
      setOrders(o.data || []);
    }).finally(() => setLoading(false));
  };

  useEffect(() => { loadData(); }, []);

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await ordersApi.remove(deleteTarget.id);
      toast.success('Прокси удалён');
      setDeleteTarget(null);
      loadData();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Ошибка при удалении');
    } finally { setDeleting(false); }
  };

  const handleRenew = async (orderId) => {
    setRenewing(orderId);
    try {
      const { data } = await ordersApi.renew(orderId);
      toast.success(`Подписка продлена! Новый баланс: ${Number(data.new_balance).toFixed(2)} ₽`);
      loadData();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Ошибка при продлении');
    } finally { setRenewing(null); }
  };

  const handleRename = async (orderId) => {
    try {
      await ordersApi.rename(orderId, renameValue);
      toast.success('Название обновлено');
      setRenaming(null);
      loadData();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Ошибка при переименовании');
    }
  };

  if (loading) return <div className="flex justify-center py-20"><Spinner size="lg" /></div>;

  // merge orders with proxy data (preserve order id/status)
  const combined = orders.map(o => {
    const p = proxies.find(px => px.order_id === o.id);
    if (!p) return o;
    return {
      ...o,
      node_host: p.node_host || o.node_host,
      node_name: p.node_name || o.node_name,
      node_flag: p.node_flag || o.node_flag,
      port: p.port,
      secret: p.secret,
      proxy_status: p.proxy_status,
      link: p.link,
      max_devices: p.max_devices || o.max_devices,
      traffic_rx_snap: p.traffic_rx_snap,
      traffic_tx_snap: p.traffic_tx_snap,
    };
  });

  const active = combined.filter(o => o.status === 'active');
  const other = combined.filter(o => o.status !== 'active' && o.status !== 'expired');

  const ProxyCard = ({ item }) => {
    const isActive = item.status === 'active';
    const expires = item.expires_at ? new Date(item.expires_at) : null;
    const daysLeft = expires ? Math.ceil((expires - Date.now()) / 86400000) : 0;
    const isVpnFree = !!item.is_vpn_free;
    const displayName = item.custom_name || item.plan_name || `Заказ #${item.id}`;
    const isRenaming = renaming === item.id;

    return (
      <div className="card-hover group block relative">
        <Link to={`/proxies/${item.id}`} className="block">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2 min-w-0 flex-1">
              <span className="text-xl shrink-0">{item.node_flag || <Globe size={18} />}</span>
              {isRenaming ? (
                <div className="flex items-center gap-1.5 flex-1 min-w-0" onClick={e => { e.preventDefault(); e.stopPropagation(); }}>
                  <input
                    value={renameValue}
                    onChange={e => setRenameValue(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') handleRename(item.id); if (e.key === 'Escape') setRenaming(null); }}
                    maxLength={50}
                    className="input text-sm py-1 px-2 flex-1 min-w-0"
                    autoFocus
                    placeholder="Название подписки"
                  />
                  <button onClick={() => handleRename(item.id)} className="p-1 text-success hover:bg-success/10 rounded-lg transition shrink-0">
                    <Check size={16} />
                  </button>
                  <button onClick={() => setRenaming(null)} className="p-1 text-gray-500 hover:bg-white/10 rounded-lg transition shrink-0">
                    <X size={16} />
                  </button>
                </div>
              ) : (
                <>
                  <span className="font-semibold truncate">{displayName}</span>
                  {isVpnFree && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded-md bg-emerald-500/20 text-emerald-400 font-medium shrink-0">VPN Бонус</span>
                  )}
                </>
              )}
            </div>
            {!isRenaming && (
              isActive
                ? <span className="badge-success flex items-center gap-1 shrink-0"><Wifi size={10} /> Активен</span>
                : <span className="badge-danger flex items-center gap-1 shrink-0"><WifiOff size={10} /> {item.status === 'expired' ? 'Истёк' : item.status}</span>
            )}
          </div>

          {isActive && (
            <div className="grid grid-cols-2 gap-3 text-sm">
              <div className="flex items-center gap-2 text-gray-400">
                <Users size={14} />
                <span>{item.max_devices || 0} устр. макс.</span>
              </div>
              <div className="flex items-center gap-2 text-gray-400">
                <Clock size={14} />
                <span className={daysLeft <= 3 ? 'text-warning' : ''}>
                  {daysLeft > 0 ? `${daysLeft} дн.` : 'Истекает'}
                </span>
              </div>
            </div>
          )}

          {isActive && !isVpnFree && (
            <div className="mt-3 flex items-center gap-2" onClick={e => e.preventDefault()}>
              <button
                onClick={(e) => { e.stopPropagation(); handleRenew(item.id); }}
                disabled={renewing === item.id}
                className="btn-primary text-xs px-3 py-1.5 rounded-lg flex items-center gap-1.5 flex-1 justify-center"
              >
                {renewing === item.id ? <Spinner size="sm" /> : <><RefreshCw size={12} /> Продлить</>}
              </button>
            </div>
          )}

          {isActive && isVpnFree && (
            <p className="mt-3 text-xs text-emerald-400/70">Действует пока активна VPN подписка</p>
          )}

          {!isActive && (
            <div className="mt-3 flex items-center justify-end text-xs text-primary opacity-0 group-hover:opacity-100 transition">
              Подробнее <ArrowRight size={12} className="ml-1" />
            </div>
          )}
        </Link>

        {/* Rename + Delete buttons */}
        <div className="absolute top-3 right-3 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition z-10">
          <button
            onClick={(e) => {
              e.preventDefault(); e.stopPropagation();
              setRenameValue(item.custom_name || item.plan_name || '');
              setRenaming(item.id);
            }}
            className="p-1.5 rounded-lg text-gray-600 hover:text-primary hover:bg-primary/10 transition"
            title="Переименовать"
          >
            <Pencil size={14} />
          </button>
          <button
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); setDeleteTarget(item); }}
            className="p-1.5 rounded-lg text-gray-600 hover:text-danger hover:bg-danger/10 transition"
            title="Удалить прокси"
          >
            <Trash2 size={14} />
          </button>
        </div>
      </div>
    );
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Мои прокси</h1>
        <Link to="/plans" className="btn-primary text-sm">Купить ещё</Link>
      </div>

      {combined.length === 0 && (
        <div className="card text-center py-12">
          <Wifi size={48} className="mx-auto text-gray-600 mb-4" />
          <p className="text-lg font-semibold mb-2">Нет активных прокси</p>
          <p className="text-gray-400 text-sm mb-6">Приобретите тариф для начала работы</p>
          <Link to="/plans" className="btn-primary">Выбрать тариф</Link>
        </div>
      )}

      {active.length > 0 && (
        <div>
          <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-3">Активные</h2>
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {active.map(item => <ProxyCard key={item.id} item={item} />)}
          </div>
        </div>
      )}

      {other.length > 0 && (
        <div>
          <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-3">Прошлые</h2>
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {other.map(item => <ProxyCard key={item.id} item={item} />)}
          </div>
        </div>
      )}

      {/* Delete confirmation modal */}
      {deleteTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4" onClick={() => !deleting && setDeleteTarget(null)}>
          <div className="bg-surface border border-white/10 rounded-2xl w-full max-w-sm p-6 space-y-5 animate-fade-in" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-bold flex items-center gap-2 text-danger">
                <AlertTriangle size={20} /> Удалить прокси
              </h2>
              <button onClick={() => setDeleteTarget(null)} disabled={deleting} className="p-1.5 text-gray-500 hover:text-gray-300 transition rounded-lg hover:bg-white/10">
                <X size={18} />
              </button>
            </div>

            <div className="space-y-3">
              <p className="text-gray-300">
                Вы действительно хотите удалить прокси <strong>{deleteTarget.plan_name || `Заказ #${deleteTarget.id}`}</strong>?
              </p>
              {deleteTarget.status === 'active' && (
                <div className="bg-danger/10 border border-danger/20 rounded-xl p-3 text-sm text-danger">
                  Внимание! Активный прокси будет отключён, подключение перестанет работать. Это действие нельзя отменить.
                </div>
              )}
              <div className="bg-surface-dark rounded-xl p-3 space-y-1 text-sm">
                <div className="flex justify-between">
                  <span className="text-gray-400">Статус</span>
                  <span className="font-semibold">{deleteTarget.status === 'active' ? 'Активен' : deleteTarget.status}</span>
                </div>
                {deleteTarget.node_flag && (
                  <div className="flex justify-between">
                    <span className="text-gray-400">Локация</span>
                    <span>{deleteTarget.node_flag} {deleteTarget.node_name || ''}</span>
                  </div>
                )}
              </div>
            </div>

            <div className="flex gap-3">
              <button onClick={() => setDeleteTarget(null)} disabled={deleting} className="btn-secondary flex-1">
                Отмена
              </button>
              <button onClick={handleDelete} disabled={deleting} className="btn-danger flex-1 flex items-center justify-center gap-2">
                {deleting ? <Spinner size="sm" /> : <><Trash2 size={14} /> Удалить</>}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
