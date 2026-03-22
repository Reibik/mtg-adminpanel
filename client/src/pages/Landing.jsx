import { Link } from 'react-router-dom';
import { Zap, Shield, Gauge, Globe, ChevronDown, ArrowRight, Info, AlertTriangle, CheckCircle, Megaphone, X, LayoutDashboard, Gift } from 'lucide-react';
import { useState, useEffect } from 'react';
import { catalogApi } from '../api/client';
import { useAuthStore } from '../store/auth';
import axios from 'axios';

const announcementConfig = {
  info: { icon: Info, border: 'border-primary/40', bg: 'from-primary/10 to-primary/5', text: 'text-primary-light', badge: 'bg-primary/20 text-primary-light' },
  warning: { icon: AlertTriangle, border: 'border-warning/40', bg: 'from-warning/10 to-warning/5', text: 'text-warning', badge: 'bg-warning/20 text-warning' },
  success: { icon: CheckCircle, border: 'border-success/40', bg: 'from-success/10 to-success/5', text: 'text-success', badge: 'bg-success/20 text-success' },
  danger: { icon: Megaphone, border: 'border-danger/40', bg: 'from-danger/10 to-danger/5', text: 'text-danger', badge: 'bg-danger/20 text-danger' },
};

const features = [
  { icon: Zap, title: 'Высокая скорость', desc: 'MTProto прокси работают напрямую, без потери скорости' },
  { icon: Shield, title: 'Полная безопасность', desc: 'Шифрование трафика и защита от блокировок' },
  { icon: Gauge, title: 'Мониторинг 24/7', desc: 'Отслеживайте статус подключения в реальном времени' },
  { icon: Globe, title: 'Выбор локации', desc: 'Серверы в разных странах для лучшего маршрута' },
];

const faqs = [
  { q: 'Что такое ST VILLAGE PROXY?', a: 'ST VILLAGE PROXY — это специальный прокси-сервер для Telegram, который обеспечивает быстрый и безопасный доступ к мессенджеру, обходя блокировки.' },
  { q: 'Как подключиться?', a: 'После оплаты вы получите ссылку и QR-код. Просто нажмите на ссылку или отсканируйте QR — Telegram подключится автоматически.' },
  { q: 'Можно ли использовать на нескольких устройствах?', a: 'Да! Количество устройств зависит от выбранного тарифа. Вы можете отслеживать подключения в личном кабинете.' },
  { q: 'Как работает автопродление?', a: 'Вы можете включить автопродление в настройках прокси. За 24 часа до окончания подписки мы напомним вам об оплате.' },
];

export default function Landing() {
  const isAuthenticated = useAuthStore(s => s.isAuthenticated);
  const [plans, setPlans] = useState([]);
  const [plansLoading, setPlansLoading] = useState(true);
  const [openFaq, setOpenFaq] = useState(null);
  const [version, setVersion] = useState('');
  const [announcements, setAnnouncements] = useState([]);
  const [dismissedAnn, setDismissedAnn] = useState(() => {
    try { return JSON.parse(localStorage.getItem('dismissed_landing_announcements') || '[]'); } catch { return []; }
  });

  useEffect(() => {
    catalogApi.plans().then(({ data }) => setPlans(data)).catch(() => {}).finally(() => setPlansLoading(false));
    axios.get('/api/version').then(r => setVersion(r.data.version || '')).catch(() => {});
    axios.get('/api/client/announcements').then(r => setAnnouncements(r.data || [])).catch(() => {});
  }, []);

  const dismissAnn = (id) => {
    const next = [...dismissedAnn, id];
    setDismissedAnn(next);
    localStorage.setItem('dismissed_landing_announcements', JSON.stringify(next));
  };

  const visibleAnn = announcements.filter(a => !dismissedAnn.includes(a.id));

  return (
    <div className="min-h-screen bg-surface-dark">
      {/* Header */}
      <header className="fixed top-0 w-full z-50 bg-surface-dark/80 backdrop-blur border-b border-white/5">
        <div className="max-w-6xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 bg-gradient-to-br from-primary to-accent rounded-lg flex items-center justify-center">
              <Zap size={18} className="text-white" />
            </div>
            <span className="text-lg font-bold gradient-text">ST VILLAGE PROXY</span>
          </div>
          <div className="flex items-center gap-3">
            {isAuthenticated ? (
              <Link to="/dashboard" className="btn-primary btn-sm flex items-center gap-2">
                <LayoutDashboard size={16} /> Личный кабинет
              </Link>
            ) : (
              <>
                <Link to="/login" className="btn-secondary btn-sm">Войти</Link>
                <Link to="/register" className="btn-primary btn-sm">Регистрация</Link>
              </>
            )}
          </div>
        </div>
      </header>

      {/* Hero */}
      <section className="pt-32 pb-20 px-4">
        <div className="max-w-4xl mx-auto text-center">
          <div className="inline-flex items-center gap-2 bg-primary/10 rounded-full px-4 py-1.5 mb-6">
            <span className="w-2 h-2 bg-success rounded-full animate-pulse" />
            <span className="text-sm text-primary-light font-medium">{version ? `Версия ${version}` : 'Доступно'} — Онлайн</span>
          </div>
          <h1 className="text-4xl md:text-6xl font-extrabold mb-6 leading-tight">
            Быстрые и безопасные{' '}
            <span className="gradient-text">прокси для Telegram</span>
          </h1>
          <p className="text-lg text-gray-400 mb-10 max-w-2xl mx-auto">
            MTProto прокси с мониторингом в реальном времени, автоматическим управлением и мгновенным подключением через QR-код
          </p>
          <div className="flex flex-col sm:flex-row gap-4 justify-center">
            {isAuthenticated ? (
              <Link to="/dashboard" className="btn-primary btn-lg">
                Перейти в кабинет <ArrowRight size={18} />
              </Link>
            ) : (
              <>
                <Link to="/register" className="btn-primary btn-lg">
                  Начать бесплатно <ArrowRight size={18} />
                </Link>
                <a href="#plans" className="btn-secondary btn-lg">
                  Смотреть тарифы
                </a>
              </>
            )}
          </div>
        </div>
      </section>

      {/* Announcements */}
      {visibleAnn.length > 0 && (
        <section className="px-4 -mt-10 mb-6 relative z-10">
          <div className="max-w-4xl mx-auto space-y-3">
            {visibleAnn.map(a => {
              const cfg = announcementConfig[a.type] || announcementConfig.info;
              const Icon = cfg.icon;
              return (
                <div key={a.id} className={`relative border ${cfg.border} bg-gradient-to-r ${cfg.bg} rounded-2xl px-5 py-4 flex items-start gap-4 backdrop-blur-sm animate-fade-in`}>
                  <div className={`w-10 h-10 rounded-xl ${cfg.badge} flex items-center justify-center shrink-0`}>
                    <Icon size={20} />
                  </div>
                  <div className="flex-1 min-w-0">
                    {a.title && <p className={`font-semibold ${cfg.text}`}>{a.title}</p>}
                    <p className="text-sm text-gray-300 mt-0.5">{a.message}</p>
                  </div>
                  <button onClick={() => dismissAnn(a.id)} className="shrink-0 p-1.5 text-gray-500 hover:text-gray-300 transition rounded-lg hover:bg-white/10">
                    <X size={16} />
                  </button>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* Features */}
      <section className="py-20 px-4 bg-surface/50">
        <div className="max-w-6xl mx-auto">
          <h2 className="text-3xl font-bold text-center mb-12">Почему <span className="gradient-text">ST VILLAGE PROXY</span>?</h2>
          <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-6">
            {features.map((f, i) => (
              <div key={i} className="card-hover text-center">
                <div className="w-12 h-12 bg-gradient-to-br from-primary/20 to-accent/20 rounded-xl flex items-center justify-center mx-auto mb-4">
                  <f.icon size={24} className="text-primary-light" />
                </div>
                <h3 className="font-semibold mb-2">{f.title}</h3>
                <p className="text-sm text-gray-400">{f.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* VPN Bonus */}
      <section className="py-20 px-4">
        <div className="max-w-4xl mx-auto">
          <div className="relative overflow-hidden rounded-3xl border border-emerald-500/20 bg-gradient-to-br from-emerald-500/10 via-surface to-primary/5 p-8 md:p-12">
            <div className="absolute top-0 right-0 w-64 h-64 bg-emerald-500/5 rounded-full -translate-y-1/2 translate-x-1/2 blur-3xl" />
            <div className="relative flex flex-col md:flex-row items-center gap-8">
              <div className="w-20 h-20 rounded-2xl bg-gradient-to-br from-emerald-500/30 to-emerald-600/20 flex items-center justify-center shrink-0">
                <Gift size={40} className="text-emerald-400" />
              </div>
              <div className="flex-1 text-center md:text-left">
                <h2 className="text-2xl md:text-3xl font-extrabold mb-3">
                  Подписчики <span className="text-emerald-400">VPN ST VILLAGE</span> — прокси бесплатно!
                </h2>
                <p className="text-gray-400 mb-4 max-w-xl">
                  Если у вас уже есть активная подписка на VPN ST VILLAGE, вы получаете бесплатный Telegram-прокси на весь срок действия VPN. Никаких доплат — просто активируйте в личном кабинете.
                </p>
                <div className="flex flex-wrap gap-4 justify-center md:justify-start text-sm">
                  <div className="flex items-center gap-2 text-emerald-400">
                    <CheckCircle size={16} /> <span>Бесплатно для подписчиков VPN</span>
                  </div>
                  <div className="flex items-center gap-2 text-emerald-400">
                    <CheckCircle size={16} /> <span>Активация в 1 клик</span>
                  </div>
                  <div className="flex items-center gap-2 text-emerald-400">
                    <CheckCircle size={16} /> <span>Действует пока активна VPN</span>
                  </div>
                </div>
                <div className="mt-6">
                  <Link to={isAuthenticated ? '/plans' : '/register'} className="inline-flex items-center gap-2 px-6 py-3 rounded-xl font-semibold text-white bg-gradient-to-r from-emerald-600 to-emerald-500 hover:from-emerald-500 hover:to-emerald-400 transition text-sm">
                    {isAuthenticated ? 'Активировать в кабинете' : 'Зарегистрироваться и получить'} <ArrowRight size={16} />
                  </Link>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Plans */}
      <section id="plans" className="py-20 px-4">
        <div className="max-w-6xl mx-auto">
          <h2 className="text-3xl font-bold text-center mb-4">Тарифные планы</h2>
          <p className="text-center text-gray-400 mb-12">Выберите подходящий план или настройте под себя</p>
          <div className="grid md:grid-cols-3 gap-6 max-w-4xl mx-auto">
            {plansLoading && (
              <div className="col-span-3 flex justify-center py-12">
                <div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin" />
              </div>
            )}
            {!plansLoading && plans.length === 0 && (
              <div className="col-span-3 text-center text-gray-500 py-12">
                Тарифы скоро появятся. Следите за обновлениями!
              </div>
            )}
            {plans.map((plan, i) => (
              <div key={plan.id} className={`card-hover relative ${i === 1 ? 'border-primary/40 ring-1 ring-primary/20' : ''}`}>
                {i === 1 && (
                  <div className="absolute -top-3 left-1/2 -translate-x-1/2 bg-gradient-to-r from-primary to-accent text-white text-xs font-bold px-4 py-1 rounded-full">
                    Популярный
                  </div>
                )}
                <h3 className="text-lg font-bold mb-1">{plan.name}</h3>
                <p className="text-sm text-gray-400 mb-4">{plan.description}</p>
                <div className="mb-6">
                  <span className="text-3xl font-extrabold">{plan.price}</span>
                  <span className="text-gray-400 ml-1">₽/{plan.period === 'monthly' ? 'мес' : plan.period === 'yearly' ? 'год' : 'день'}</span>
                </div>
                <ul className="space-y-2 mb-6 text-sm text-gray-300">
                  <li>✓ До {plan.max_devices} устройств</li>
                  {plan.traffic_limit_gb && <li>✓ {plan.traffic_limit_gb} ГБ трафика</li>}
                  <li>✓ Сброс трафика: {plan.traffic_reset_interval === 'monthly' ? 'ежемесячно' : plan.traffic_reset_interval === 'daily' ? 'ежедневно' : plan.traffic_reset_interval}</li>
                  <li>✓ Мониторинг 24/7</li>
                </ul>
                <Link to={isAuthenticated ? '/plans' : '/register'} className={i === 1 ? 'btn-primary w-full' : 'btn-secondary w-full'}>
                  Выбрать
                </Link>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* FAQ */}
      <section className="py-20 px-4 bg-surface/50">
        <div className="max-w-2xl mx-auto">
          <h2 className="text-3xl font-bold text-center mb-12">Частые вопросы</h2>
          <div className="space-y-3">
            {faqs.map((faq, i) => (
              <div key={i} className="card cursor-pointer" onClick={() => setOpenFaq(openFaq === i ? null : i)}>
                <div className="flex items-center justify-between">
                  <h3 className="font-semibold text-sm">{faq.q}</h3>
                  <ChevronDown size={18} className={`text-gray-400 transition-transform ${openFaq === i ? 'rotate-180' : ''}`} />
                </div>
                {openFaq === i && (
                  <p className="text-sm text-gray-400 mt-3 animate-fade-in">{faq.a}</p>
                )}
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="py-14 px-4 border-t border-white/5 bg-surface-dark">
        <div className="max-w-6xl mx-auto">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-10 mb-10">
            {/* Brand */}
            <div>
              <div className="flex items-center gap-2 mb-3">
                <div className="w-8 h-8 bg-gradient-to-br from-primary to-accent rounded-lg flex items-center justify-center">
                  <Zap size={16} className="text-white" />
                </div>
                <span className="text-lg font-bold gradient-text">ST VILLAGE PROXY</span>
              </div>
              <p className="text-sm text-gray-400 leading-relaxed">
                Быстрые и безопасные MTProto прокси для Telegram с мониторингом и автоматическим управлением.
              </p>
            </div>

            {/* Navigation */}
            <div>
              <h4 className="font-semibold text-gray-200 mb-4">Навигация</h4>
              <ul className="space-y-2 text-sm">
                <li><a href="#plans" className="text-gray-400 hover:text-primary transition">Тарифы</a></li>
                <li><Link to="/login" className="text-gray-400 hover:text-primary transition">Войти</Link></li>
                <li><Link to="/register" className="text-gray-400 hover:text-primary transition">Регистрация</Link></li>
                <li><Link to="/changelog" className="text-gray-400 hover:text-primary transition">История обновлений</Link></li>
              </ul>
            </div>

            {/* Legal */}
            <div>
              <h4 className="font-semibold text-gray-200 mb-4">Информация</h4>
              <ul className="space-y-2 text-sm">
                <li><Link to="/offer" className="text-gray-400 hover:text-primary transition">Публичная оферта</Link></li>
                <li><Link to="/privacy" className="text-gray-400 hover:text-primary transition">Политика конфиденциальности</Link></li>
              </ul>
            </div>
          </div>

          <div className="pt-6 border-t border-white/5 flex flex-col sm:flex-row items-center justify-between gap-3">
            <p className="text-xs text-gray-500">© {new Date().getFullYear()} ST VILLAGE PROXY. Все права защищены.</p>
            {version && <Link to="/changelog" className="text-xs text-gray-500 hover:text-primary transition">v{version}</Link>}
          </div>
        </div>
      </footer>
    </div>
  );
}
