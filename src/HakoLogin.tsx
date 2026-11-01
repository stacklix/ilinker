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
  return <div className="settings-stack"><HakoConnection notify={notify} onSaved={() => { setRequest(null); setRevision(v => v + 1); }} /><section className="panel"><div className="panel-header"><div><h2>身份绑定</h2><p>绑定后，可使用手机确认登录。密码登录继续可用。</p></div></div>
    <div className="settings-form"><ErrorLine error={loadError} />{!data ? <Loading /> : <>
      <p>{data.bound ? `已绑定：${data.username} · ${data.issuer}` : data.configured ? `尚未绑定 · ${data.issuer}` : '请先填写并保存 Hako 连接配置，再扫码绑定。'}</p>
      {request ? <HakoScan initial={request} onComplete={() => { setRequest(null); setRevision(v => v + 1); notify('Hako 已绑定，可用于扫码登录'); }} onCancel={() => setRequest(null)} /> : (data.configured || data.bound) && <form className="hako-settings-form" onSubmit={async e => {
        e.preventDefault(); setBusy(true); setError('');
        try {
          if (data.bound) { await post('/auth/hako/unbind', { currentPassword: password }); setRevision(v => v + 1); notify('已解除 Hako 绑定'); }
          else setRequest(await post<HakoRequest>('/auth/hako/bind', { currentPassword: password }));
          setPassword('');
        } catch (error) { setError((error as Error).message); } finally { setBusy(false); }
      }}><label>当前管理员密码<input type="password" required maxLength={128} autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} /></label><Button type="submit" busy={busy} variant={data.bound ? 'danger' : 'primary'}>{data.bound ? '解除 Hako 绑定' : '验证密码并扫码绑定'}</Button></form>}
    </>}<ErrorLine error={error} /></div>
  </section></div>;
}

interface HakoSettingsData { configured: boolean; serverUrl: string; clientId: string; secretSet: boolean; secretMask: string; source: 'page' | 'environment' | 'none' }
function HakoConnection({ notify, onSaved }: { notify: (message: string) => void; onSaved: () => void }) {
  const { data, error: loadError, setData } = useResource<HakoSettingsData>('/auth/hako/settings');
  const [serverUrl, setServerUrl] = useState(''), [clientId, setClientId] = useState(''), [secret, setSecret] = useState(''), [password, setPassword] = useState('');
  const [replacing, setReplacing] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [editing, setEditing] = useState(false);
  const resetDraft = () => { setServerUrl(data?.serverUrl || ''); setClientId(data?.clientId || ''); setReplacing(false); setSecret(''); setPassword(''); setError(''); };
  useEffect(() => { if (data) { setServerUrl(data.serverUrl); setClientId(data.clientId); setReplacing(false); setSecret(''); setPassword(''); setEditing(false); } }, [data]);
  const editSecret = !data?.secretSet || replacing;
  return <section className="panel"><div className="panel-header"><div><h2>Hako 连接配置</h2><p>{editing ? '填写连接信息，保存后立即生效。' : '用于 Hako 扫码登录的连接信息。'}</p></div><div className="settings-header-actions"><span className="settings-source">{data?.source === 'page' ? '页面配置' : data?.source === 'environment' ? '来自环境变量' : '尚未配置'}</span>{data && !editing && <Button type="button" variant="secondary" onClick={() => { resetDraft(); setEditing(true); }}>{data.configured ? '编辑配置' : '配置连接'}</Button>}</div></div>
    <ErrorLine error={loadError} />
    {!data ? !loadError && <div className="settings-form"><Loading /></div> : !editing ? <div className="settings-summary"><dl>
      <div><dt>Hako 服务地址</dt><dd>{data.serverUrl || '尚未配置'}</dd></div>
      <div><dt>应用 ID</dt><dd>{data.clientId || '尚未配置'}</dd></div>
      <div><dt>应用 SK</dt><dd className="settings-secret-mask">{data.secretSet ? data.secretMask : '尚未配置'}</dd></div>
    </dl><p>{data.secretSet ? 'SK 已加密保存，仅显示掩码。修改连接信息请点击“编辑配置”。' : '在 Hako 创建应用后，点击“配置连接”填写服务地址、应用 ID 和 SK。'}</p></div> : <form className="settings-form hako-connection-form" onSubmit={async e => {
      e.preventDefault(); setBusy(true); setError('');
      try {
        const value = await api<HakoSettingsData>('/auth/hako/settings', { method: 'PUT', body: JSON.stringify({ serverUrl, clientId, ...(editSecret && secret ? { clientSecret: secret } : {}), currentPassword: password }) });
        setData(value); setPassword(''); setSecret(''); setReplacing(false); setEditing(false); onSaved(); notify('Hako 配置已保存并生效');
      } catch (error) { setError((error as Error).message); } finally { setBusy(false); }
    }}>
      <ErrorLine error={loadError} />
      <label>Hako 服务地址<input type="url" required value={serverUrl} onChange={e => setServerUrl(e.target.value)} placeholder="https://hako.example.com" autoComplete="off" disabled={!data} /><small>填写 Hako 的 HTTPS 根地址。</small></label>
      <label>应用 ID<input required maxLength={80} value={clientId} onChange={e => setClientId(e.target.value)} placeholder="Hako 创建的应用 ID" autoComplete="off" disabled={!data} /></label>
      <label>应用 SK<div className="settings-secret-field"><input type="password" required={!data?.secretSet} readOnly={!editSecret} value={editSecret ? secret : data?.secretMask || ''} onChange={e => setSecret(e.target.value)} autoComplete="new-password" placeholder={data?.secretSet ? '留空保留已保存的 SK' : '粘贴 Hako 生成的 SK'} disabled={!data} />{data?.secretSet && <Button type="button" variant="secondary" onClick={() => { setReplacing(v => !v); setSecret(''); }}>{replacing ? '取消替换' : '替换 SK'}</Button>}</div><small>{data?.secretSet ? 'SK 已加密保存，打码显示。替换时填写新值，留空保留原值。' : 'SK 将加密保存，保存后只显示掩码。'}</small></label>
      <label>当前管理员密码<input type="password" required maxLength={128} autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} /></label>
      <p className="quiet small">更换服务地址或应用 ID 时需填写新 SK。配置变化会使已有 Hako 登录失效；更换服务地址后需重新绑定。</p>
      <ErrorLine error={error} /><div className="inline-actions"><Button busy={busy} disabled={!data} type="submit">保存配置</Button><Button type="button" variant="secondary" disabled={busy} onClick={() => { resetDraft(); setEditing(false); }}>取消</Button></div>
    </form>}
  </section>;
}
