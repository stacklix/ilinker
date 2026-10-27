import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowUp, Bot as BotIcon, Info, MessageSquare, Search, Send, Webhook, X, RefreshCw, Pencil, ChevronRight } from 'lucide-react';
import type { Bot, Conversation, Message } from '../shared/types';
import type { Navigate, Route } from './App';
import { api, patch, post } from './api';
import { Avatar, Button, Empty, ErrorLine, IconButton, Loading, Modal, Status, conversationName, fullTime, useResource } from './ui';

interface Props { bots: Bot[]; revision: number; refresh: () => void; notify: (message: string) => void; route: Route; navigate: Navigate }
export function MessagesPage({ bots, revision, refresh, notify, route, navigate }: Props) {
  const bot = bots.find(b => b.id === route.botId) || bots[0];
  const { data: conversation, error, loading } = useResource<Conversation | null>(bot ? `/bots/${bot.id}/conversation` : null, revision);
  const selected = conversation?.botId === bot?.id ? conversation : null;
  useEffect(() => { if (bot && conversation?.unread) void post(`/bots/${bot.id}/conversation/read`).then(refresh).catch(() => {}); }, [bot?.id, conversation?.id, conversation?.unread]);
  if (!bots.length) return <div className="chat-no-bots"><Empty icon={BotIcon} title="先连接一个机器人" text="连接微信并收到第一条消息后，即可开始聊天。" action={<Button onClick={() => navigate('bots')}>前往连接机器人</Button>} /></div>;
  return <div className={`chat-workspace ${route.botId ? 'has-bot' : ''}`}><aside className="bot-rail"><div className="rail-label">机器人 <span>{bots.length}</span></div>{bots.map(item => <button key={item.id} className={`bot-rail-item ${bot?.id === item.id ? 'selected' : ''}`} onClick={() => navigate('messages', item.id)} title={item.name}><span className="bot-rail-icon"><MessageSquare size={20} /><i className={item.status === 'online' ? 'online' : ''} /></span><span><strong>{item.name}</strong><small>{item.status === 'online' ? '在线' : item.status === 'pending' ? '待登录' : '未连接'}</small></span>{item.unread > 0 && <b className="unread">{item.unread > 99 ? '99+' : item.unread}</b>}</button>)}<button className="rail-manage" onClick={() => navigate('bots')}><BotIcon size={16} />管理机器人<ChevronRight size={13} /></button></aside>
    <div className="chat-area"><ErrorLine error={error} />{loading && !selected ? <Loading /> : selected && bot ? <Chat key={bot.id} bot={bot} conversation={selected} revision={revision} refresh={refresh} notify={notify} onBack={() => navigate('messages')} /> : <Empty icon={MessageSquare} title="等待第一条微信消息" text={bot?.status === 'online' ? '在微信中给这个机器人发送一条消息，即可查看聊天记录和发送通知。' : '请先扫码连接机器人，再在微信中给它发送一条消息。'} action={bot?.status !== 'online' && <Button variant="secondary" onClick={() => navigate('bots')}>管理连接</Button>} />}</div>
  </div>;
}
function Chat({ bot, conversation, revision, refresh, notify, onBack }: { bot: Bot; conversation: Conversation; revision: number; refresh: () => void; notify: (message: string) => void; onBack: () => void }) {
  const [draft, setDraft] = useState(''), [sending, setSending] = useState(false), [error, setError] = useState('');
  const [messages, setMessages] = useState<Message[]>([]), [nextCursor, setNextCursor] = useState<string | null>(null), [loading, setLoading] = useState(true), [loadingMore, setLoadingMore] = useState(false);
  const [details, setDetails] = useState(false), [editing, setEditing] = useState(false), [remark, setRemark] = useState(conversation.remark);
  const [searching, setSearching] = useState(false), [search, setSearch] = useState('');
  const scroll = useRef<HTMLDivElement>(null), textarea = useRef<HTMLTextAreaElement>(null), nearBottom = useRef(true), initialized = useRef(false);
  const currentMessages = useRef(messages); currentMessages.current = messages;
  const base = `/bots/${bot.id}/conversation`;
  useEffect(() => {
    const controller = new AbortController();
    if (!initialized.current) setLoading(true);
    const load = async () => {
      const result = await api<{ items: Message[]; nextCursor: string | null }>(`${base}/messages?search=${encodeURIComponent(search)}`, { signal: controller.signal });
      if (initialized.current && !search && currentMessages.current.length) {
        const known = new Set(currentMessages.current.map(m => m.id));
        let page = result;
        // Catch up across bursts larger than one page instead of leaving a gap in the timeline.
        while (page.nextCursor && !page.items.some(m => known.has(m.id))) {
          page = await api<{ items: Message[]; nextCursor: string | null }>(`${base}/messages?before=${page.nextCursor}`, { signal: controller.signal });
          result.items = [...page.items, ...result.items];
        }
        const included = new Set(result.items.map(m => m.id));
        const pending = currentMessages.current.filter(m => ['queued', 'sending'].includes(m.status) && !included.has(m.id));
        // Older queued tasks can change status even while the newest page keeps moving.
        const updates = await Promise.all(pending.map(m => api<Message>(`/messages/${m.id}`, { signal: controller.signal })));
        result.items = [...updates, ...result.items];
      }
      return result;
    };
    load().then(result => {
      if (controller.signal.aborted) return;
      setMessages(previous => {
        if (!initialized.current || search) return result.items;
        const map = new Map(previous.map(m => [m.id, m])); result.items.forEach(m => map.set(m.id, m));
        return [...map.values()];
      });
      if (!initialized.current || search) setNextCursor(result.nextCursor);
      initialized.current = true; setError('');
    }).catch(error => { if (!controller.signal.aborted) setError(error.message); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [base, revision, search]);
  useLayoutEffect(() => { if (nearBottom.current && scroll.current && !search) scroll.current.scrollTop = scroll.current.scrollHeight; }, [messages, search, loading]);
  useEffect(() => {
    if (!scroll.current) return;
    const observer = new ResizeObserver(() => { if (nearBottom.current && scroll.current && !search) scroll.current.scrollTop = scroll.current.scrollHeight; });
    observer.observe(scroll.current); return () => observer.disconnect();
  }, [search]);
  async function older() {
    if (!nextCursor || !scroll.current) return;
    setLoadingMore(true); const beforeHeight = scroll.current.scrollHeight;
    try {
      const result = await api<{ items: Message[]; nextCursor: string | null }>(`${base}/messages?before=${nextCursor}&search=${encodeURIComponent(search)}`);
      setMessages(previous => [...result.items.filter(m => !previous.some(p => p.id === m.id)), ...previous]);
      setNextCursor(result.nextCursor);
      requestAnimationFrame(() => { if (scroll.current) scroll.current.scrollTop += scroll.current.scrollHeight - beforeHeight; });
    } catch (error) { setError((error as Error).message); } finally { setLoadingMore(false); }
  }
  async function send() {
    if (!draft.trim() || sending) return;
    setSending(true); setError('');
    try {
      const message = await post<Message>(`${base}/messages`, { text: draft });
      nearBottom.current = true; setMessages(previous => previous.some(m => m.id === message.id) ? previous : [...previous, message]); setDraft(''); refresh(); textarea.current?.focus();
    } catch (error) { setError((error as Error).message); } finally { setSending(false); }
  }
  const unavailable = !bot.hasCredentials || ['stopped', 'pending', 'expired', 'logging_in'].includes(bot.status) || !conversation.hasContext;
  return <><div className="chat-main"><header className="chat-header"><button className="icon-btn chat-back" aria-label="返回机器人" onClick={onBack}><ArrowLeft size={19} /></button><Avatar name={conversationName(conversation)} small /><div><h2>{conversationName(conversation)}</h2><p>{bot.name}<span>·</span>微信私聊</p></div><div className="chat-header-actions"><IconButton icon={Search} label="搜索聊天记录" onClick={() => { setSearching(v => !v); if (searching) { setSearch(''); initialized.current = false; } }} /><IconButton icon={Info} label="会话信息" onClick={() => setDetails(v => !v)} /></div></header>
    {searching && <div className="chat-search"><Search size={16} /><input autoFocus value={search} onChange={e => { initialized.current = false; setMessages([]); setSearch(e.target.value); }} placeholder="搜索当前会话的聊天记录…" aria-label="搜索聊天记录" /><IconButton icon={X} label="关闭搜索" onClick={() => { setSearching(false); setSearch(''); initialized.current = false; }} /></div>}
    <div className="chat-timeline" ref={scroll} onScroll={() => { if (scroll.current) nearBottom.current = scroll.current.scrollHeight - scroll.current.scrollTop - scroll.current.clientHeight < 120; }}>
      {loading ? <Loading /> : <>{nextCursor && <div className="load-older"><button disabled={loadingMore} onClick={older}><ArrowUp size={13} />{loadingMore ? '加载中…' : '查看更早消息'}</button></div>}{!messages.length && <Empty title={search ? '没有匹配的聊天记录' : '开始这段会话'} text={search ? '试试其他关键词。' : '发送一条消息，或者等待对方回复。'} />}{messages.map((message, index) => {
        const previous = messages[index - 1]; const showTime = !previous || message.createdAt - previous.createdAt > 5 * 60_000;
        return <div key={message.id}>{showTime && <div className="timeline-time">{fullTime(message.createdAt)}</div>}<div className={`chat-message ${message.direction === 'out' ? 'outgoing' : 'incoming'}`}><Avatar name={message.direction === 'in' ? conversationName(conversation) : bot.name} small /><div className="bubble-wrap">{message.direction === 'out' && <span className="bubble-source">{/^webhooks?\b/i.test(message.source) && <Webhook size={11} />}{message.source.replace(/^webhooks?\b/i, 'Webhooks')}</span>}<div className="bubble">{message.type === 'image' ? message.imageUrl ? <a className="message-image-link" href={message.imageUrl} target="_blank" rel="noreferrer"><img className="message-image" src={message.imageUrl} alt="图片消息，点击查看原图" onLoad={() => { if (nearBottom.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight; }} /></a> : <span className="image-pending">[图片]{['queued', 'sending'].includes(message.status) ? ' 正在准备…' : ''}</span> : message.text}</div>{message.direction === 'out' && <div className="bubble-status"><Status status={message.status} />{message.status === 'failed' && <button onClick={async () => { try { await post(`/messages/${message.id}/retry`); refresh(); } catch (error) { setError((error as Error).message); } }}><RefreshCw size={12} />重试</button>}</div>}{message.error && <div className="bubble-error">{message.error}</div>}</div></div></div>;
      })}</>}
    </div><div className="chat-composer">{unavailable && <div className="composer-hint"><Info size={14} />{!conversation.hasContext ? '请在微信中给机器人发送消息，重新建立会话上下文。' : '机器人未连接，请先启动连接。'}</div>}<ErrorLine error={error} /><div className="composer-toolbar"><span><MessageSquare size={15} />文本消息</span><span>{draft.length}/4000</span></div><textarea ref={textarea} value={draft} onChange={e => setDraft(e.target.value)} maxLength={4000} disabled={unavailable} placeholder={unavailable ? '连接恢复后即可发送消息' : '输入消息…'} aria-label="消息内容" onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); } }} /><div className="composer-footer"><small>Enter 发送，Shift + Enter 换行</small><Button icon={Send} busy={sending} disabled={unavailable || !draft.trim()} onClick={send}>发送</Button></div></div>
  </div>{details && <aside className="chat-detail"><div className="chat-detail-title"><h3>会话信息</h3><IconButton icon={X} label="关闭会话信息" onClick={() => setDetails(false)} /></div><Avatar name={conversationName(conversation)} /><h3>{conversationName(conversation)}</h3><dl><dt>机器人</dt><dd>{bot.name}</dd><dt>平台</dt><dd>微信 iLink</dd><dt>接收对象 ID</dt><dd className="mono break-all">{conversation.peerId}</dd><dt>会话上下文</dt><dd>{conversation.hasContext ? '已保存' : '待建立'}</dd></dl><Button variant="secondary" icon={Pencil} onClick={() => setEditing(true)}>修改备注</Button></aside>}
    {editing && <Modal title="修改会话备注" onClose={() => setEditing(false)}><form className="modal-form" onSubmit={async e => { e.preventDefault(); try { await patch(base, { remark }); refresh(); setEditing(false); } catch (error) { setError((error as Error).message); } }}><label>备注名称<input value={remark} onChange={e => setRemark(e.target.value)} maxLength={80} placeholder="设置一个容易识别的名字" /></label><div className="modal-footer"><Button variant="secondary" type="button" onClick={() => setEditing(false)}>取消</Button><Button type="submit">保存备注</Button></div></form></Modal>}
  </>;
}
