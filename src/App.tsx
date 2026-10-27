import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Activity, ArrowDownLeft, ArrowRight, ArrowUpRight, Bot as BotIcon, ChevronRight, CircleHelp, Command, KeyRound, LayoutDashboard, Link2, LogOut, MessageSquare, Plus, Radio, Settings, ShieldCheck, Webhook, X, Zap } from 'lucide-react';
import { api, post, patch } from './api';
import { Button, Empty, ErrorLine, Loading, Status, relative, useResource } from './ui';
import type { Bot, Overview } from '../shared/types';
import { BotsPage } from './Bots';
import { MessagesPage } from './Messages';
import { WebHooksPage } from './WebHooks';

type Page = 'overview' | 'bots' | 'messages' | 'webhooks' | 'settings';
export interface Route { page: Page; botId?: string }
export type Navigate = (page: Page, botId?: string) => void;
function readRoute(): Route {
  const [page, search] = location.hash.slice(1).split('?');
  const params = new URLSearchParams(search);
  return { page: ['overview', 'bots', 'messages', 'webhooks', 'settings'].includes(page) ? page as Page : 'overview', botId: params.get('bot') || undefined };
}
export function App() {
  const [user, setUser] = useState<{ username: string } | null>(null);
  const [setup, setSetup] = useState(false), [booting, setBooting] = useState(true), [bootError, setBootError] = useState('');
  const [route, setRoute] = useState(readRoute);
  const [revision, setRevision] = useState(0), [toast, setToast] = useState(''), [live, setLive] = useState(false);
  const refresh = useCallback(() => setRevision(v => v + 1), []);
  const notify = useCallback((message: string) => setToast(message), []);
  const navigate: Navigate = (page, botId) => {
    const params = new URLSearchParams(); if (botId) params.set('bot', botId);
    location.hash = `${page}${params.size ? `?${params}` : ''}`;
  };
  const bootstrap = useCallback(async () => {
    setBooting(true); setBootError('');
    try {
      const status = await api<{ setupRequired: boolean }>('/auth/status'); setSetup(status.setupRequired);
      if (!status.setupRequired) { try { setUser(await api('/auth/me')); } catch { setUser(null); } }
    } catch (error) { setBootError((error as Error).message); }
    setBooting(false);
  }, []);
  useEffect(() => { void bootstrap(); const handler = () => setRoute(readRoute()); window.addEventListener('hashchange', handler); return () => window.removeEventListener('hashchange', handler); }, [bootstrap]);
  useEffect(() => { const handler = () => setUser(null); window.addEventListener('unauthorized', handler); return () => window.removeEventListener('unauthorized', handler); }, []);
  useEffect(() => { if (toast) { const timer = setTimeout(() => setToast(''), 4500); return () => clearTimeout(timer); } }, [toast]);
  useEffect(() => {
    if (!user) return;
    const stream = new EventSource('/api/v1/events'); let timer: ReturnType<typeof setTimeout> | undefined;
    stream.onopen = () => setLive(true); stream.onerror = () => setLive(false);
    stream.onmessage = () => { if (!timer) timer = setTimeout(() => { refresh(); timer = undefined; }, 300); };
    const fallback = setInterval(refresh, 15_000);
    return () => { stream.close(); clearInterval(fallback); clearTimeout(timer); setLive(false); };
  }, [user, refresh]);
  const botsResource = useResource<Bot[]>(user ? '/bots' : null, revision);
  const bots = botsResource.data || [];
  if (booting) return <div className="boot"><Logo /><Loading /></div>;
  if (bootError) return <div className="boot"><Logo /><ErrorLine error={bootError} /><Button onClick={bootstrap}>重新连接</Button></div>;
  if (!user) return <Auth setup={setup} onLogin={value => { setSetup(false); setUser(value); refresh(); }} />;
  const titles: Record<Page, [string, string]> = {
    overview: ['工作台', '所有连接与消息，尽在掌握。'], bots: ['机器人管理', '连接你的微信，让通知开始流动。'],
    messages: ['消息中心', '按机器人查看会话和消息。'], webhooks: ['Webhooks', '一个地址，连接你的应用与消息。'], settings: ['系统设置', '管理你的账号与网关。'],
  };
  return <div className="app-shell">
    <aside className="sidebar"><Logo /><div className="workspace-label">工作空间 <span>个人</span></div>
      <nav aria-label="主导航">{([
        ['overview', LayoutDashboard, '工作台'], ['bots', BotIcon, '机器人'], ['messages', MessageSquare, '消息中心'], ['webhooks', Webhook, 'Webhooks'],
      ] as const).map(([key, Icon, label]) => <button key={key} aria-label={label} title={label} className={`nav-item ${route.page === key ? 'active' : ''}`} onClick={() => navigate(key)}><Icon size={19} /><span>{label}</span>{key === 'bots' && <small>{bots.length}</small>}{key === 'messages' && bots.reduce((n, b) => n + b.unread, 0) > 0 && <b className="nav-dot" />}</button>)}</nav>
      <div className="sidebar-bottom"><button className={`nav-item ${route.page === 'settings' ? 'active' : ''}`} onClick={() => navigate('settings')}><Settings size={19} />系统设置</button>
        <div className="sidebar-status"><span className={`live-dot ${live ? '' : 'muted'}`} /><span>{live ? '实时连接正常' : '正在恢复实时连接'}</span><span className="version">v0.1</span></div>
        <div className="user-block"><span className="user-avatar">{user.username[0].toUpperCase()}</span><div><strong>{user.username}</strong><small>管理员</small></div><button className="icon-btn" title="退出登录" aria-label="退出登录" onClick={async () => { await post('/auth/logout'); setUser(null); }}><LogOut size={17} /></button></div>
      </div>
    </aside>
    <main className={`main ${route.page === 'messages' ? 'main-chat' : ''}`}>
      <div className="topbar"><div>工作空间 <ChevronRight size={13} /><strong>{titles[route.page][0]}</strong></div><span className="topbar-note"><ShieldCheck size={14} /> 私有通知网关</span></div>
      {route.page !== 'messages' && <header className="page-header"><div><div className="eyebrow">{({ overview: 'OVERVIEW', bots: 'CONNECTIONS', webhooks: 'INTEGRATIONS', settings: 'PREFERENCES' } as Record<string, string>)[route.page]}</div><h1>{titles[route.page][0]}</h1><p>{titles[route.page][1]}</p></div>{route.page === 'overview' && <Button icon={Plus} onClick={() => navigate('bots')}>连接机器人</Button>}</header>}
      <ErrorLine error={botsResource.error} />
      {route.page === 'overview' && <OverviewPage bots={bots} revision={revision} navigate={navigate} />}
      {route.page === 'bots' && <BotsPage bots={bots} revision={revision} refresh={refresh} notify={notify} navigate={navigate} />}
      {route.page === 'messages' && <MessagesPage bots={bots} revision={revision} refresh={refresh} notify={notify} route={route} navigate={navigate} />}
      {route.page === 'webhooks' && <WebHooksPage bots={bots} revision={revision} refresh={refresh} notify={notify} navigate={navigate} />}
      {route.page === 'settings' && <SettingsPage username={user.username} notify={notify} onLogout={() => setUser(null)} />}
    </main>
    {toast && <div className="toast" role="status"><ShieldCheck size={18} />{toast}<button onClick={() => setToast('')} aria-label="关闭提示"><X size={15} /></button></div>}
  </div>;
}
function Logo() { return <div className="logo"><span><Link2 size={24} strokeWidth={2.6} /></span><strong>iLinker<span>通知网关</span></strong></div>; }
function Auth({ setup, onLogin }: { setup: boolean; onLogin: (user: { username: string }) => void }) {
  const [username, setUsername] = useState(''), [password, setPassword] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError('');
    try {
      if (setup) await post('/auth/setup', { username, password });
      onLogin(await post('/auth/login', { username, password }));
    } catch (error) { setError((error as Error).message); } finally { setBusy(false); }
  }
  return <div className="auth-page"><div className="auth-decoration"><div className="auth-orbit orbit-one" /><div className="auth-orbit orbit-two" /><div className="auth-brand"><Logo /><div className="auth-pitch"><span className="pill"><Radio size={13} /> CONNECT YOUR WORLD</span><h1>让每一条通知，<br />找到它的目的地。</h1><p>连接机器人、查看会话、接入应用。<br />你的消息，在一个地方有序流动。</p><div className="auth-flow"><span><Command size={22} /></span><i /><span className="flow-center"><Link2 size={27} /></span><i /><span><MessageSquare size={22} /></span></div></div><small>iLinker · 你的私有通知网关</small></div></div>
    <div className="auth-form-wrap"><form className="auth-form" onSubmit={submit}><div className="auth-mark"><KeyRound size={23} /></div><h2>{setup ? '创建你的工作空间' : '欢迎回来'}</h2><p>{setup ? '首次使用，先设置一个管理员账号。' : '登录 iLinker，继续连接你的消息。'}</p>
      <label>管理员账号<input required minLength={3} maxLength={40} value={username} onChange={e => setUsername(e.target.value)} autoComplete="username" placeholder="输入管理员账号" /></label>
      <label>密码<input required minLength={setup ? 10 : 1} maxLength={128} type="password" value={password} onChange={e => setPassword(e.target.value)} autoComplete={setup ? 'new-password' : 'current-password'} placeholder={setup ? '设置至少 10 位密码' : '输入密码'} /></label>
      <ErrorLine error={error} /><Button type="submit" busy={busy} icon={ArrowRight}>{setup ? '创建并进入后台' : '登录后台'}</Button><div className="auth-note"><ShieldCheck size={14} />凭证加密保存，数据由你掌控</div>
    </form></div></div>;
}
function OverviewPage({ bots, revision, navigate }: { bots: Bot[]; revision: number; navigate: Navigate }) {
  const { data, error } = useResource<Overview>('/overview', revision);
  if (!data) return error ? <ErrorLine error={error} /> : <Loading />;
  const metrics = [
    { label: '在线机器人', value: data.onlineBots, suffix: `/ ${data.bots}`, icon: BotIcon, caption: '已建立的消息连接', style: 'green' },
    { label: '今日接收', value: data.receivedToday, icon: ArrowDownLeft, caption: '来自所有机器人的消息', style: 'blue' },
    { label: '今日发送', value: data.sentToday, icon: ArrowUpRight, caption: '已提交平台的消息', style: 'purple' },
    { label: '待处理异常', value: data.failedToday, icon: Activity, caption: '今日失败或结果待确认', style: 'orange' },
  ];
  const max = Math.max(4, ...data.activity.flatMap(d => [d.incoming, d.outgoing]));
  return <div className="page-content overview"><ErrorLine error={error} /><div className="metrics">{metrics.map(metric => <div className="metric" key={metric.label}><div className="metric-top"><span>{metric.label}</span><span className={`metric-icon ${metric.style}`}><metric.icon size={18} /></span></div><div className="metric-value">{metric.value.toLocaleString()}<small>{metric.suffix}</small></div><span className="metric-caption">{metric.caption}</span></div>)}</div>
    {!bots.length && <div className="welcome-banner"><div className="welcome-icon"><Zap size={26} /></div><div><h3>从第一个机器人开始</h3><p>扫码连接微信，建立会话，再为你的应用生成一个 Webhooks 地址。</p></div><Button variant="secondary" icon={ArrowRight} onClick={() => navigate('bots')}>开始连接</Button></div>}
    <div className="overview-grid"><section className="panel"><div className="panel-header"><div><h2>消息活动</h2><p>最近 7 天的消息流动</p></div><div className="legend"><span><i className="legend-in" />接收</span><span><i className="legend-out" />发送</span></div></div>
      <div className="chart"><div className="chart-grid"><span>{max}</span><span>{Math.round(max / 2)}</span><span>0</span></div><div className="bars">{data.activity.map(day => <div className="bar-day" key={day.date}><div className="bar-pair" title={`${day.date} 接收 ${day.incoming} / 发送 ${day.outgoing}`}><div className="bar bar-in" style={{ height: `${day.incoming / max * 100}%`, minHeight: day.incoming ? 4 : 0 }} /><div className="bar bar-out" style={{ height: `${day.outgoing / max * 100}%`, minHeight: day.outgoing ? 4 : 0 }} /></div><span>{day.date.slice(5).replace('-', '/')}</span></div>)}</div>{!data.activity.some(d => d.incoming || d.outgoing) && <span className="chart-empty">接入后，这里会显示真实消息活动</span>}</div>
    </section><section className="panel"><div className="panel-header"><div><h2>连接状态</h2><p>你的机器人与应用</p></div><button className="text-link" onClick={() => navigate('bots')}>管理 <ArrowRight size={14} /></button></div>
      <div className="connection-summary"><span className="connection-ring"><Radio size={29} /></span><div><strong>{data.onlineBots}<small> 个在线</small></strong><span>{data.bots} 个机器人 · {data.webhooks} 个启用的 Webhooks</span></div></div>
      <div className="connection-list">{bots.slice(0, 3).map(bot => <button key={bot.id} onClick={() => navigate('messages', bot.id)}><span className="mini-platform"><MessageSquare size={15} /></span><strong>{bot.name}</strong><Status status={bot.status} bot /></button>)}{!bots.length && <p className="quiet">还没有机器人连接</p>}</div><div className="queue-note"><span className="live-dot" />{data.queued ? `${data.queued} 条消息正在等待处理` : '当前没有待发送任务'}</div>
    </section></div>
    <section className="panel"><div className="panel-header"><div><h2>最近消息</h2><p>接收与发送，统一留痕</p></div><button className="text-link" onClick={() => navigate('messages')}>查看全部 <ArrowRight size={14} /></button></div>
      {!data.recentMessages.length ? <Empty icon={MessageSquare} title="消息将在这里汇合" text="连接机器人后，在微信中发一条消息即可建立第一个会话。" /> : <div className="table-scroll"><table><thead><tr><th>消息内容</th><th>机器人 / 会话</th><th>来源</th><th>状态</th><th>时间</th></tr></thead><tbody>{data.recentMessages.map(message => <tr key={message.id} onClick={() => navigate('messages', message.botId)} className="clickable"><td><div className="message-preview"><span className={message.direction === 'in' ? 'direction-in' : 'direction-out'}>{message.direction === 'in' ? <ArrowDownLeft size={16} /> : <ArrowUpRight size={16} />}</span><span>{message.text}</span></div></td><td><strong>{message.botName}</strong><small className="cell-sub">{message.conversationName}</small></td><td><span className="source-tag">{message.source}</span></td><td><Status status={message.status} /></td><td className="nowrap quiet">{relative(message.createdAt)}</td></tr>)}</tbody></table></div>}
    </section><div className="page-foot"><Link2 size={13} /> iLinker · 让消息有序流动 <span>统计时区：Asia/Shanghai</span></div>
  </div>;
}
function SettingsPage({ username, notify, onLogout }: { username: string; notify: (message: string) => void; onLogout: () => void }) {
  const [currentPassword, setCurrent] = useState(''), [newPassword, setNew] = useState(''), [confirm, setConfirm] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  return <div className="page-content settings-content"><section className="panel"><div className="panel-header"><div><h2>账号安全</h2><p>当前管理员：{username}</p></div><ShieldCheck size={21} className="accent" /></div><form className="settings-form" onSubmit={async e => { e.preventDefault(); if (newPassword !== confirm) { setError('两次输入的新密码不一致'); return; } setBusy(true); setError(''); try { await patch('/auth/password', { currentPassword, newPassword }); notify('密码已更新，请重新登录'); onLogout(); } catch (error) { setError((error as Error).message); } finally { setBusy(false); } }}><label>当前密码<input required type="password" autoComplete="current-password" value={currentPassword} onChange={e => setCurrent(e.target.value)} /></label><label>新密码<input required type="password" minLength={10} maxLength={128} autoComplete="new-password" value={newPassword} onChange={e => setNew(e.target.value)} placeholder="至少 10 位" /></label><label>确认新密码<input required type="password" minLength={10} maxLength={128} autoComplete="new-password" value={confirm} onChange={e => setConfirm(e.target.value)} /></label><ErrorLine error={error} /><Button busy={busy} type="submit" icon={KeyRound}>更新密码</Button></form></section>
    <section className="panel"><div className="panel-header"><div><h2>关于网关</h2><p>iLinker v0.1.0</p></div><CircleHelp size={20} className="quiet" /></div><div className="about-lines"><div><span>当前平台</span><strong>微信 iLink · 文本收发 / Webhooks 图片</strong></div><div><span>数据存储</span><strong>本地 SQLite</strong></div><div><span>Webhooks 认证</span><code>/webhook/message/&#123;token&#125;</code></div><div><span>历史消息</span><strong>自网关接入后保存</strong></div><p>首次建立会话，请在微信中给已连接的机器人发送一条消息。Webhooks 支持发送图片；收到的图片、语音、文件和视频当前显示消息摘要。</p></div></section>
  </div>;
}
