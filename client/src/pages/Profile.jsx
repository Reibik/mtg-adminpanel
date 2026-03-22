import { useEffect, useState, useCallback, useRef } from 'react';
import api, { profileApi } from '../api/client';
import { useAuthStore } from '../store/auth';
import { useToast } from '../components/ui/Toast';
import { User, Mail, Lock, Send, CheckCircle, AlertTriangle, Unlink } from 'lucide-react';
import Spinner from '../components/ui/Spinner';

function LinkTelegramSection({ customer, setCustomer, toast }) {
  const [botUsername, setBotUsername] = useState(null);
  const [loading, setLoading] = useState(false);
  const containerRef = useRef(null);

  useEffect(() => {
    api.get('/config').then(({ data }) => {
      if (data.telegram_bot_username) setBotUsername(data.telegram_bot_username);
    }).catch(() => {});
  }, []);

  const handleTelegramAuth = useCallback(async (user) => {
    setLoading(true);
    try {
      const { data } = await profileApi.linkTelegram(user);
      if (data.customer) setCustomer(data.customer);
      toast.success(data.merged ? 'Telegram привязан, аккаунты объединены!' : 'Telegram успешно привязан!');
    } catch (err) {
      toast.error(err.response?.data?.error || 'Ошибка привязки Telegram');
    } finally {
      setLoading(false);
    }
  }, [setCustomer, toast]);

  useEffect(() => {
    if (!botUsername || !containerRef.current) return;

    window.onTelegramLinkAuth = handleTelegramAuth;

    const script = document.createElement('script');
    script.src = 'https://telegram.org/js/telegram-widget.js?22';
    script.async = true;
    script.setAttribute('data-telegram-login', botUsername);
    script.setAttribute('data-size', 'large');
    script.setAttribute('data-radius', '12');
    script.setAttribute('data-onauth', 'onTelegramLinkAuth(user)');
    script.setAttribute('data-request-access', 'write');

    containerRef.current.innerHTML = '';
    containerRef.current.appendChild(script);

    return () => { delete window.onTelegramLinkAuth; };
  }, [botUsername, handleTelegramAuth]);

  if (!botUsername) return null;

  return (
    <div className="card space-y-4">
      <h3 className="font-semibold flex items-center gap-2">
        <svg className="w-[18px] h-[18px] text-[#2AABEE]" viewBox="0 0 24 24" fill="currentColor">
          <path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z"/>
        </svg>
        Привязать Telegram
      </h3>
      <p className="text-sm text-gray-400">Привяжите Telegram для быстрого входа и дополнительной безопасности</p>
      {loading ? (
        <div className="flex items-center gap-2 text-primary text-sm"><Spinner size="sm" /> Привязываем...</div>
      ) : (
        <div ref={containerRef} />
      )}
    </div>
  );
}

export default function Profile() {
  const customer = useAuthStore(s => s.customer);
  const setCustomer = useAuthStore(s => s.setCustomer);
  const toast = useToast();

  const [name, setName] = useState(customer?.name || '');
  const [saving, setSaving] = useState(false);

  // Link email (for Telegram users without email)
  const [linkEmail, setLinkEmail] = useState('');
  const [linkSent, setLinkSent] = useState(false);
  const [linkLoading, setLinkLoading] = useState(false);

  // Change password
  const [pw, setPw] = useState({ current: '', newPw: '', confirm: '' });
  const [pwLoading, setPwLoading] = useState(false);

  // Refresh profile
  useEffect(() => {
    profileApi.get().then(({ data }) => {
      setCustomer(data);
      setName(data.name || '');
    }).catch(() => {});
  }, []);

  const handleSaveName = async () => {
    setSaving(true);
    try {
      await profileApi.update({ name });
      const { data } = await profileApi.get();
      setCustomer(data);
      toast.success('Имя обновлено');
    } catch (err) { toast.error(err.response?.data?.error || 'Ошибка'); }
    finally { setSaving(false); }
  };

  const handleLinkEmail = async (e) => {
    e.preventDefault();
    setLinkLoading(true);
    try {
      const { data } = await profileApi.linkEmail({ email: linkEmail });
      if (data.merged) {
        if (data.customer) setCustomer(data.customer);
        toast.success('Аккаунты объединены, email привязан!');
      } else {
        setLinkSent(true);
        toast.success('Письмо отправлено — проверьте почту');
      }
    } catch (err) { toast.error(err.response?.data?.error || 'Ошибка'); }
    finally { setLinkLoading(false); }
  };

  const handleChangePw = async (e) => {
    e.preventDefault();
    if (pw.newPw !== pw.confirm) { toast.error('Пароли не совпадают'); return; }
    setPwLoading(true);
    try {
      await profileApi.changePassword({ currentPassword: pw.current, newPassword: pw.newPw });
      toast.success('Пароль изменён');
      setPw({ current: '', newPw: '', confirm: '' });
    } catch (err) { toast.error(err.response?.data?.error || 'Ошибка'); }
    finally { setPwLoading(false); }
  };

  const hasEmail = !!customer?.email;
  const emailVerified = !!customer?.email_verified;

  return (
    <div className="space-y-6 max-w-2xl">
      <h1 className="text-2xl font-bold">Профиль</h1>

      {/* Basic info */}
      <div className="card space-y-4">
        <h3 className="font-semibold flex items-center gap-2"><User size={18} className="text-primary" /> Основная информация</h3>

        <div>
          <label className="text-xs text-gray-400 mb-1 block">Имя</label>
          <div className="flex gap-2">
            <input value={name} onChange={e => setName(e.target.value)} className="input flex-1" placeholder="Ваше имя" />
            <button onClick={handleSaveName} disabled={saving} className="btn-primary px-4">
              {saving ? <Spinner size="sm" /> : 'Сохранить'}
            </button>
          </div>
        </div>

        {hasEmail && (
          <div>
            <label className="text-xs text-gray-400 mb-1 block">Email</label>
            <div className="flex items-center gap-2">
              <input readOnly value={customer.email} className="input flex-1 opacity-70" />
              {emailVerified
                ? <span className="badge-success flex items-center gap-1"><CheckCircle size={10} /> Подтверждён</span>
                : <span className="badge-warning flex items-center gap-1"><AlertTriangle size={10} /> Не подтверждён</span>
              }
            </div>
          </div>
        )}

        {customer?.telegram_id && (
          <div>
            <label className="text-xs text-gray-400 mb-1 block">Telegram</label>
            <div className="flex items-center gap-2">
              <input readOnly value={`@${customer.telegram_username || customer.telegram_id}`} className="input flex-1 opacity-70" />
              {customer?.email && customer?.has_password && (
                <button
                  onClick={async () => {
                    if (!confirm('Отвязать Telegram? Вы сможете входить только по email и паролю.')) return;
                    try {
                      const { data } = await profileApi.unlinkTelegram();
                      if (data.customer) setCustomer(data.customer);
                      toast.success('Telegram отвязан');
                    } catch (err) { toast.error(err.response?.data?.error || 'Ошибка'); }
                  }}
                  className="btn-danger px-3 py-2 flex items-center gap-1 text-xs"
                >
                  <Unlink size={12} /> Отвязать
                </button>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Link Telegram (for accounts without telegram) */}
      {!customer?.telegram_id && (
        <LinkTelegramSection customer={customer} setCustomer={setCustomer} toast={toast} />
      )}

      {/* Link Email (for accounts without email) */}
      {!hasEmail && (
        <div className="card space-y-4">
          <h3 className="font-semibold flex items-center gap-2"><Mail size={18} className="text-accent" /> Привязать Email</h3>
          <p className="text-sm text-gray-400">Привяжите email для получения уведомлений и восстановления пароля</p>
          {linkSent ? (
            <div className="flex items-center gap-2 text-success text-sm">
              <CheckCircle size={16} /> Письмо отправлено на {linkEmail}. Перейдите по ссылке.
            </div>
          ) : (
            <form onSubmit={handleLinkEmail} className="flex gap-2">
              <input type="email" value={linkEmail} onChange={e => setLinkEmail(e.target.value)}
                className="input flex-1" placeholder="your@email.com" required />
              <button type="submit" disabled={linkLoading} className="btn-primary px-4 flex items-center gap-2">
                {linkLoading ? <Spinner size="sm" /> : <><Send size={14} /> Привязать</>}
              </button>
            </form>
          )}
        </div>
      )}

      {/* Change password */}
      {hasEmail && (
        <div className="card space-y-4">
          <h3 className="font-semibold flex items-center gap-2"><Lock size={18} className="text-warning" /> Сменить пароль</h3>
          <form onSubmit={handleChangePw} className="space-y-3">
            <input type="password" value={pw.current} onChange={e => setPw(p => ({ ...p, current: e.target.value }))}
              className="input" placeholder="Текущий пароль" required />
            <input type="password" value={pw.newPw} onChange={e => setPw(p => ({ ...p, newPw: e.target.value }))}
              className="input" placeholder="Новый пароль (мин. 6)" required minLength={6} />
            <input type="password" value={pw.confirm} onChange={e => setPw(p => ({ ...p, confirm: e.target.value }))}
              className="input" placeholder="Подтвердите новый пароль" required minLength={6} />
            <button type="submit" disabled={pwLoading} className="btn-primary">
              {pwLoading ? <Spinner size="sm" /> : 'Сменить пароль'}
            </button>
          </form>
        </div>
      )}
    </div>
  );
}
