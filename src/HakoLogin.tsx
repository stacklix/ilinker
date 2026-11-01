import { useEffect, useRef, useState } from 'react';
import { api, post, remove } from './api';
import { Button, ErrorLine, Loading, useResource } from './ui';

interface HakoRequest { id: string; qrImage: string; qrContent: string; confirmationCode: string; expiresAt: number; purpose: 'bind' | 'login' }

export function HakoScan({ initial, onComplete, onCancel }: { initial?: HakoRequest; onComplete: (value: { username: string }) => void; onCancel?: () => void }) {
  const [request, setRequest] = useState<HakoRequest | null>(initial || null), [status, setStatus] = useState('pending');
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [generation, setGeneration] = useState(0), [now, setNow] = useState(Date.now());
  const callback = useRef(onComplete); callback.current = onComplete;
  useEffect(() => {
    let disposed = false, timer: ReturnType<typeof setTimeout> | undefined, active = initial;
    setError(''); setStatus('pending'); setBusy(true);
    const poll = async () => {
      if (disposed || !active) return;
      if (active.expiresAt <= Date.now()) { setStatus('expired'); return; }
      try {
        const result = await api<{ status: string }>(`/auth/hako/requests/${active.id}`);
        if (disposed) return;
        setStatus(result.status);
        if (result.status === 'approved') {
          setBusy(true);
          const user = await post<{ username: string }>(`/auth/hako/requests/${active.id}/complete`, {});
          if (!disposed) callback.current(user);
          return;
        }
        if (result.status !== 'denied') timer = setTimeout(poll, 2000);
      } catch (error) { if (!disposed) setError((error as Error).message); }
      finally { if (!disposed) setBusy(false); }
    };
    void (async () => {
      try {
        active = initial || await post<HakoRequest>('/auth/hako/requests', {});
        if (!disposed) { setRequest(active); setBusy(false); await poll(); }
        else void remove(`/auth/hako/requests/${active.id}`).catch(() => {});
      } catch (error) { if (!disposed) { setError((error as Error).message); setBusy(false); } }
    })();
    return () => { disposed = true; clearTimeout(timer); if (active) void remove(`/auth/hako/requests/${active.id}`).catch(() => {}); };
  }, [initial, generation]);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  const expired = !!request && request.expiresAt <= now;
  const finished = expired || status === 'denied' || !!error;
  return <div className="hako-scan" aria-live="polite">
    {request && !finished ? <><img src={request.qrImage} width={240} height={240} alt="Hako 扫码登录二维码" /><span className="quiet small">核对手机与网页上的确认码</span><strong className="hako-code">{request.confirmationCode}</strong><p>{status === 'scanned' ? '已扫码，请在 Hako 中确认' : status === 'approved' ? '正在完成授权…' : '使用 Hako → 设置 → 扫码登录'}</p><span className="quiet small">{Math.max(0, Math.ceil((request.expiresAt - now) / 1000))} 秒后过期</span></> : busy ? <Loading /> : null}
    {expired && <p>二维码已过期，请重新生成。</p>}{status === 'denied' && <p>已在手机上拒绝此次请求。</p>}
    <ErrorLine error={error} />
    <div className="inline-actions">{finished && <Button type="button" variant="secondary" onClick={() => { if (initial) onCancel?.(); else { setRequest(null); setGeneration(v => v + 1); } }}>重新生成二维码</Button>}{onCancel && <Button type="button" variant="ghost" onClick={onCancel}>取消绑定</Button>}</div>
  </div>;
}

export function HakoSettings({ notify }: { notify: (message: string) => void }) {
  const [revision, setRevision] = useState(0), [password, setPassword] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false), [request, setRequest] = useState<HakoRequest | null>(null);
  const { data, error: loadError } = useResource<{ configured: boolean; bound: boolean; issuer?: string; username?: string }>('/auth/hako/binding', revision);
  return <section className="panel"><div className="panel-header"><div><h2>Hako 扫码登录</h2><p>绑定后，可使用手机确认登录。密码登录继续可用。</p></div></div>
    <div className="settings-form"><ErrorLine error={loadError} />{!data ? <Loading /> : <>
      <p>{data.bound ? `已绑定：${data.username} · ${data.issuer}` : data.configured ? `尚未绑定 · ${data.issuer}` : '尚未配置 Hako，请在服务端配置 HAKO_URL、HAKO_CLIENT_ID 和 HAKO_CLIENT_SECRET。'}</p>
      {request ? <HakoScan initial={request} onComplete={() => { setRequest(null); setRevision(v => v + 1); notify('Hako 已绑定，可用于扫码登录'); }} onCancel={() => setRequest(null)} /> : (data.configured || data.bound) && <form className="hako-settings-form" onSubmit={async e => {
        e.preventDefault(); setBusy(true); setError('');
        try {
          if (data.bound) { await post('/auth/hako/unbind', { currentPassword: password }); setRevision(v => v + 1); notify('已解除 Hako 绑定'); }
          else setRequest(await post<HakoRequest>('/auth/hako/bind', { currentPassword: password }));
          setPassword('');
        } catch (error) { setError((error as Error).message); } finally { setBusy(false); }
      }}><label>当前管理员密码<input type="password" required maxLength={128} autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} /></label><Button type="submit" busy={busy} variant={data.bound ? 'danger' : 'primary'}>{data.bound ? '解除 Hako 绑定' : '验证密码并扫码绑定'}</Button></form>}
    </>}<ErrorLine error={error} /></div>
  </section>;
}
