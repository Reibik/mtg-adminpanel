import { Outlet, Link, useLocation, useNavigate } from 'react-router-dom';
import { useAuthStore } from '../../store/auth';
import { authApi } from '../../api/client';
import { LayoutDashboard, Wifi, CreditCard, User, LogOut, Menu, X, Zap, Tag, Home } from 'lucide-react';
import { useState, useEffect } from 'react';
import AnnouncementsBanner from '../ui/AnnouncementsBanner';
import axios from 'axios';

const navItems = [
  { to: '/dashboard', icon: LayoutDashboard, label: 'Обзор', shortLabel: 'Обзор' },
  { to: '/proxies', icon: Wifi, label: 'Мои прокси', shortLabel: 'Прокси' },
  { to: '/plans', icon: Zap, label: 'Тарифы', shortLabel: 'Тарифы' },
  { to: '/payments', icon: CreditCard, label: 'Платежи', shortLabel: 'Платежи' },
  { to: '/profile', icon: User, label: 'Профиль', shortLabel: 'Профиль' },
];

export default function Layout() {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const { customer, logout } = useAuthStore();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [version, setVersion] = useState('');

  useEffect(() => {
    axios.get('/api/version').then(r => setVersion(r.data.version || '')).catch(() => {});
  }, []);

  const handleLogout = () => {
    const refreshToken = useAuthStore.getState().refreshToken;
    authApi.logout({ refreshToken }).catch(() => {});
    logout();
    navigate('/');
  };

  return (
    <div className="min-h-screen flex">
      {/* Sidebar — Desktop */}
      <aside className="hidden lg:flex flex-col w-60 bg-surface border-r border-white/5 p-4 fixed top-0 left-0 h-screen overflow-y-auto z-40">
        <Link to="/dashboard" className="flex items-center gap-2 px-3 py-2 mb-6">
          <div className="w-8 h-8 bg-gradient-to-br from-primary to-accent rounded-lg flex items-center justify-center">
            <Zap size={18} />
          </div>
          <span className="text-lg font-bold gradient-text">ST VILLAGE PROXY</span>
        </Link>

        <nav className="flex-1 space-y-1">
          {navItems.map(item => (
            <Link
              key={item.to}
              to={item.to}
              className={`flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-all ${
                pathname.startsWith(item.to)
                  ? 'bg-primary/20 text-primary-light'
                  : 'text-gray-400 hover:bg-white/5 hover:text-gray-200'
              }`}
            >
              <item.icon size={18} />
              {item.label}
            </Link>
          ))}
        </nav>

        <div className="border-t border-white/5 pt-4 mt-4">
          <div className="px-3 mb-3">
            <p className="text-sm font-medium text-gray-200 truncate">{customer?.name || customer?.email || 'Пользователь'}</p>
            <p className="text-xs text-gray-500 truncate">{customer?.email || customer?.telegram_username || ''}</p>
          </div>
          <button onClick={handleLogout} className="flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm text-gray-400 hover:bg-danger/10 hover:text-danger w-full transition-all">
            <LogOut size={18} />
            Выйти
          </button>
        </div>
      </aside>

      {/* Mobile top bar — compact */}
      <div className="lg:hidden fixed top-0 left-0 right-0 z-50 bg-surface/95 backdrop-blur-lg border-b border-white/5 safe-top">
        <div className="px-4 py-3 flex items-center justify-between">
          <Link to="/dashboard" className="flex items-center gap-2">
            <div className="w-7 h-7 bg-gradient-to-br from-primary to-accent rounded-lg flex items-center justify-center">
              <Zap size={14} />
            </div>
            <span className="font-bold gradient-text text-sm">ST VILLAGE</span>
          </Link>
          <button onClick={handleLogout} className="p-2 text-gray-500 hover:text-danger transition active:scale-90">
            <LogOut size={18} />
          </button>
        </div>
      </div>

      {/* Main content */}
      <main className="flex-1 min-w-0 lg:p-8 lg:ml-60 p-4 pt-16 pb-24 lg:pt-8 lg:pb-8 safe-left safe-right flex flex-col">
        <div className="max-w-6xl mx-auto animate-fade-in flex-1 w-full">
          <AnnouncementsBanner />
          <Outlet />
        </div>
        <footer className="mt-12 pt-6 border-t border-white/5 max-w-6xl mx-auto w-full hidden lg:block">
          <div className="flex flex-col sm:flex-row items-center justify-between gap-3 text-xs text-gray-500">
            <span>© {new Date().getFullYear()} ST VILLAGE PROXY</span>
            <div className="flex items-center gap-4">
              <Link to="/" className="hover:text-primary transition flex items-center gap-1">
                <Home size={10} /> Главная
              </Link>
              {version && <Link to="/updates" className="hover:text-primary transition flex items-center gap-1">
                <Tag size={10} /> v{version}
              </Link>}
              <Link to="/offer" className="hover:text-gray-300 transition">Оферта</Link>
              <Link to="/privacy" className="hover:text-gray-300 transition">Конфиденциальность</Link>
            </div>
          </div>
        </footer>
      </main>

      {/* Mobile bottom tab bar */}
      <nav className="lg:hidden fixed bottom-0 left-0 right-0 z-50 bg-surface/95 backdrop-blur-lg border-t border-white/5 safe-bottom">
        <div className="flex items-stretch h-16">
          {navItems.map(item => {
            const isActive = pathname.startsWith(item.to);
            return (
              <Link
                key={item.to}
                to={item.to}
                className={`flex-1 flex flex-col items-center justify-center gap-0.5 transition-all active:scale-90 ${
                  isActive ? 'text-primary' : 'text-gray-500'
                }`}
              >
                <div className={`relative ${isActive ? '' : ''}`}>
                  <item.icon size={20} strokeWidth={isActive ? 2.5 : 1.8} />
                  {isActive && (
                    <div className="absolute -top-1 left-1/2 -translate-x-1/2 w-1 h-1 bg-primary rounded-full" />
                  )}
                </div>
                <span className={`text-[10px] font-medium ${isActive ? 'text-primary' : ''}`}>
                  {item.shortLabel}
                </span>
              </Link>
            );
          })}
        </div>
      </nav>
    </div>
  );
}
