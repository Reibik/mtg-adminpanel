import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { catalogApi, ordersApi, paymentsApi, balanceApi, vpnApi } from '../api/client';
import { useToast } from '../components/ui/Toast';
import { Zap, Globe, Check, Star, ShieldCheck, X, Wallet, CreditCard, Gift } from 'lucide-react';
import Spinner from '../components/ui/Spinner';

export default function Plans() {
  const [plans, setPlans] = useState([]);
  const [locations, setLocations] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selectedPlan, setSelectedPlan] = useState(null);
  const [selectedLoc, setSelectedLoc] = useState('');
  const [ordering, setOrdering] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [balance, setBalance] = useState(0);
  const [vpnStatus, setVpnStatus] = useState(null);
  const [vpnOrdering, setVpnOrdering] = useState(false);
  const [vpnLocFlag, setVpnLocFlag] = useState('');
  const toast = useToast();
  const navigate = useNavigate();

  useEffect(() => {
    Promise.all([
      catalogApi.plans(),
      catalogApi.locations(),
      balanceApi.get().catch(() => ({ data: { balance: 0 } })),
      vpnApi.status().catch(() => ({ data: null })),
    ]).then(([p, l, b, v]) => {
      setPlans(p.data || []);
      setLocations(l.data || []);
      setBalance(b.data?.balance || 0);
      setVpnStatus(v.data || null);
    }).catch(() => {
      setError('Не удалось загрузить тарифы');
    }).finally(() => setLoading(false));
  }, []);

  const handleOrder = async () => {
    if (!selectedPlan) return;
    setOrdering(true);
    try {
      // Step 1: Create order
      const { data: order } = await ordersApi.create({
        plan_id: selectedPlan.id,
        location_flag: selectedLoc || undefined,
      });
      // Step 2: Create payment via YooKassa
      const { data: payment } = await paymentsApi.create({ order_id: order.id });
      if (payment.confirmation_url) {
        window.location.href = payment.confirmation_url;
      } else {
        toast.error('Не удалось создать платёж. Проверьте настройки ЮКассы.');
      }
    } catch (err) {
      toast.error(err.response?.data?.error || 'Ошибка при оформлении');
    } finally { setOrdering(false); }
  };

  const handlePayBalance = async () => {
    if (!selectedPlan) return;
    setOrdering(true);
    try {
      const { data: order } = await ordersApi.create({
        plan_id: selectedPlan.id,
        location_flag: selectedLoc || undefined,
      });
      await ordersApi.payWithBalance(order.id);
      toast.success('Оплата прошла успешно!');
      setShowConfirm(false);
      navigate('/proxies');
    } catch (err) {
      toast.error(err.response?.data?.error || 'Ошибка оплаты с баланса');
    } finally { setOrdering(false); }
  };

  const handleFreeVpnOrder = async () => {
    setVpnOrdering(true);
    try {
      await ordersApi.createFreeVpn({ location_flag: selectedLoc || vpnLocFlag || undefined });
      toast.success('Бесплатный прокси активирован!');
      navigate('/proxies');
    } catch (err) {
      toast.error(err.response?.data?.error || 'Ошибка при создании бесплатного прокси');
    } finally { setVpnOrdering(false); }
  };

  if (loading) return <div className="flex justify-center py-20"><Spinner size="lg" /></div>;

  if (error) return (
    <div className="card text-center py-12">
      <Zap size={48} className="mx-auto text-gray-600 mb-4" />
      <p className="text-lg font-semibold text-danger">{error}</p>
      <button onClick={() => { setError(''); setLoading(true); window.location.reload(); }} className="btn-secondary mt-4">Попробовать снова</button>
    </div>
  );

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Тарифы</h1>
        <p className="text-gray-400 text-sm mt-1">Выберите подходящий тариф и локацию</p>
      </div>

      {/* VPN ST VILLAGE free proxy banner */}
      {vpnStatus?.enabled && vpnStatus.hasVpn && !vpnStatus.hasFreeProxy && (
        <div className="card border border-emerald-500/30 bg-emerald-500/5">
          <div className="flex flex-col sm:flex-row items-start gap-3 sm:gap-4">
            <div className="w-10 h-10 rounded-xl bg-emerald-500/20 flex items-center justify-center shrink-0">
              <Gift size={20} className="text-emerald-400" />
            </div>
            <div className="flex-1 min-w-0">
              <h3 className="font-bold text-emerald-400">VPN ST VILLAGE — бесплатный прокси</h3>
              <p className="text-sm text-gray-400 mt-1">
                У вас активна VPN-подписка! Получите 1 бесплатный Telegram-прокси.
                {vpnStatus.vpnExpiresAt && (
                  <span className="block mt-0.5 text-xs text-gray-500">
                    Действует до {new Date(vpnStatus.vpnExpiresAt).toLocaleDateString('ru-RU')}
                  </span>
                )}
              </p>
              {locations.length > 0 && (
                <div className="flex flex-wrap gap-1.5 mt-3">
                  <button onClick={() => setVpnLocFlag('')}
                    className={`px-3 py-1.5 rounded-lg text-xs transition ${!vpnLocFlag ? 'bg-emerald-500 text-white' : 'bg-surface-light text-gray-300 hover:bg-surface-lighter'}`}>
                    🌐 Авто
                  </button>
                  {locations.map(loc => (
                    <button key={loc.flag} onClick={() => setVpnLocFlag(loc.flag)}
                      className={`px-3 py-1.5 rounded-lg text-xs transition ${vpnLocFlag === loc.flag ? 'bg-emerald-500 text-white' : 'bg-surface-light text-gray-300 hover:bg-surface-lighter'}`}>
                      {loc.flag} {loc.name}
                    </button>
                  ))}
                </div>
              )}
              <button onClick={handleFreeVpnOrder} disabled={vpnOrdering}
                className="mt-3 flex items-center gap-2 px-5 py-2.5 rounded-xl font-semibold text-white transition bg-gradient-to-r from-emerald-600 to-emerald-500 hover:from-emerald-500 hover:to-emerald-400 disabled:opacity-50 text-sm w-full sm:w-auto justify-center sm:justify-start">
                {vpnOrdering ? <Spinner size="sm" /> : <><Gift size={14} /> Получить бесплатно</>}
              </button>
            </div>
          </div>
        </div>
      )}

      {vpnStatus?.enabled && vpnStatus.hasVpn && vpnStatus.hasFreeProxy && (
        <div className="card border border-emerald-500/20 bg-emerald-500/5">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-emerald-500/20 flex items-center justify-center shrink-0">
              <Check size={16} className="text-emerald-400" />
            </div>
            <p className="text-sm text-emerald-400">
              Ваш бесплатный прокси по VPN ST VILLAGE уже активен
            </p>
          </div>
        </div>
      )}

      {/* Plans grid */}
      <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {plans.map((p, i) => {
          const isPopular = i === 1;
          const isSelected = selectedPlan?.id === p.id;
          const isVpnPlan = vpnStatus?.freePlanId && vpnStatus.freePlanId === p.id;
          return (
            <button key={p.id}
              onClick={() => setSelectedPlan(p)}
              className={`card text-left transition relative ${isSelected ? 'ring-2 ring-primary' : isVpnPlan ? 'ring-1 ring-emerald-500/30 hover:ring-emerald-500/50' : 'hover:ring-1 hover:ring-gray-600'}`}
            >
              {isVpnPlan && (
                <span className="absolute -top-2 left-4 flex items-center gap-1 text-xs font-bold px-3 py-0.5 rounded-full bg-gradient-to-r from-emerald-600 to-emerald-500 text-white">
                  <Gift size={10} /> VPN Бонус
                </span>
              )}
              {isPopular && !isVpnPlan && (
                <span className="absolute -top-2 right-4 badge-warning flex items-center gap-1 text-xs">
                  <Star size={10} /> Популярный
                </span>
              )}
              <h3 className="text-lg font-bold mb-1">{p.name}</h3>
              <p className="text-3xl font-black gradient-text mb-1">
                {p.price} <span className="text-base font-normal text-gray-400">₽</span>
              </p>
              <p className="text-xs text-gray-500 mb-4">{p.period === 'monthly' ? 'в месяц' : p.period === 'yearly' ? 'в год' : 'в день'}</p>
              {p.description && (
                <ul className="space-y-2 text-sm text-gray-300">
                  {p.description.split('\n').map((line, j) => (
                    <li key={j} className="flex items-start gap-2">
                      <Check size={14} className="text-success mt-0.5 shrink-0" />
                      <span>{line}</span>
                    </li>
                  ))}
                </ul>
              )}
              {isSelected && (
                <div className="absolute top-3 right-3 w-5 h-5 rounded-full bg-primary flex items-center justify-center">
                  <Check size={12} className="text-white" />
                </div>
              )}
            </button>
          );
        })}
      </div>

      {/* Location picker */}
      {selectedPlan && locations.length > 0 && (
        <div className="card">
          <h3 className="font-semibold mb-3 flex items-center gap-2">
            <Globe size={18} className="text-accent" /> Выберите локацию
          </h3>
          <div className="flex flex-wrap gap-2">
            <button onClick={() => setSelectedLoc('')}
              className={`px-4 py-2 rounded-xl text-sm transition ${!selectedLoc ? 'bg-primary text-white' : 'bg-surface-light text-gray-300 hover:bg-surface-lighter'}`}>
              🌐 Авто (лучшая)
            </button>
            {locations.map(loc => (
              <button key={loc.flag} onClick={() => setSelectedLoc(loc.flag)}
                className={`px-4 py-2 rounded-xl text-sm transition ${selectedLoc === loc.flag ? 'bg-primary text-white' : 'bg-surface-light text-gray-300 hover:bg-surface-lighter'}`}>
                {loc.flag} {loc.name} <span className="text-xs text-gray-500">({loc.node_ids?.length || 0})</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Order button */}
      {selectedPlan && (
        <div className="card flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 sm:gap-4">
          <div className="min-w-0">
            <p className="text-sm text-gray-400">Выбран тариф:</p>
            <p className="font-bold truncate">{selectedPlan.name} — {selectedPlan.price} ₽ / {selectedPlan.period === 'monthly' ? 'мес.' : selectedPlan.period === 'yearly' ? 'год' : 'день'}</p>
          </div>
          {vpnStatus?.hasVpn && vpnStatus?.freePlanId === selectedPlan.id && !vpnStatus?.hasFreeProxy ? (
            <button onClick={handleFreeVpnOrder} disabled={vpnOrdering} className="w-full sm:w-auto px-8 flex items-center justify-center gap-2 py-2.5 rounded-xl font-semibold text-white transition bg-gradient-to-r from-emerald-600 to-emerald-500 hover:from-emerald-500 hover:to-emerald-400 disabled:opacity-50">
              {vpnOrdering ? <Spinner size="sm" /> : <><Gift size={16} /> Активировать бесплатно!</>}
            </button>
          ) : (
            <button onClick={() => setShowConfirm(true)} disabled={ordering} className="btn-primary w-full sm:w-auto px-8 flex items-center justify-center gap-2">
              <Zap size={16} /> Оформить заказ
            </button>
          )}
        </div>
      )}

      {/* Confirmation modal */}
      {showConfirm && selectedPlan && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4" onClick={() => setShowConfirm(false)}>
          <div className="bg-surface border border-white/10 rounded-2xl w-full max-w-md p-6 space-y-5 animate-fade-in" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-bold flex items-center gap-2">
                <ShieldCheck size={20} className="text-primary" /> Подтверждение заказа
              </h2>
              <button onClick={() => setShowConfirm(false)} className="p-1.5 text-gray-500 hover:text-gray-300 transition rounded-lg hover:bg-white/10">
                <X size={18} />
              </button>
            </div>

            <div className="space-y-3">
              <div className="flex justify-between items-center py-2 border-b border-white/5">
                <span className="text-sm text-gray-400">Тариф</span>
                <span className="font-semibold">{selectedPlan.name}</span>
              </div>
              <div className="flex justify-between items-center py-2 border-b border-white/5">
                <span className="text-sm text-gray-400">Период</span>
                <span className="font-semibold">{selectedPlan.period === 'monthly' ? '1 месяц' : selectedPlan.period === 'yearly' ? '1 год' : '1 день'}</span>
              </div>
              <div className="flex justify-between items-center py-2 border-b border-white/5">
                <span className="text-sm text-gray-400">Локация</span>
                <span className="font-semibold">{selectedLoc ? `${selectedLoc} ${locations.find(l => l.flag === selectedLoc)?.name || ''}` : '🌐 Авто (лучшая)'}</span>
              </div>
              <div className="flex justify-between items-center py-2 border-b border-white/5">
                <span className="text-sm text-gray-400">Устройства</span>
                <span className="font-semibold">до {selectedPlan.max_devices}</span>
              </div>
              <div className="flex justify-between items-center py-3">
                <span className="text-sm text-gray-400">К оплате</span>
                <span className="text-2xl font-black gradient-text">{selectedPlan.price} ₽</span>
              </div>
            </div>

            <p className="text-xs text-gray-500 text-center">
              Нажимая кнопку оплаты, вы соглашаетесь с условиями публичной оферты
            </p>

            <div className="space-y-2">
              {balance >= selectedPlan.price && (
                <button onClick={handlePayBalance} disabled={ordering} className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-xl font-semibold text-white transition bg-gradient-to-r from-emerald-600 to-emerald-500 hover:from-emerald-500 hover:to-emerald-400 disabled:opacity-50">
                  {ordering ? <Spinner size="sm" /> : <><Wallet size={16} /> Оплатить с баланса ({balance} ₽)</>}
                </button>
              )}
              <button onClick={() => { setShowConfirm(false); handleOrder(); }} disabled={ordering} className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-xl font-semibold text-white transition bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 disabled:opacity-50">
                {ordering ? <Spinner size="sm" /> : <><CreditCard size={16} /> Оплатить через ЮКассу</>}
              </button>
              <button onClick={() => setShowConfirm(false)} className="w-full btn-secondary">
                Отмена
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
