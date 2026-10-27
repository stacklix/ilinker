import { useLayoutEffect, useRef, useState } from 'react';
import { ArrowRight, ChevronLeft, ChevronRight, MessageSquare, RefreshCw, Search, Webhook } from 'lucide-react';
import type { WebHook, WebHookMessagePage } from '../shared/types';
import type { Navigate } from './App';
import { post } from './api';
import { Avatar, Button, Empty, ErrorLine, Loading, Status, fullTime, useResource } from './ui';

export function WebHookMessages({ webhook, revision, refresh, navigate, onClose }: {
  webhook: WebHook; revision: number; refresh: () => void; navigate: Navigate; onClose: () => void;
}) {
  const [search, setSearch] = useState(''), [type, setType] = useState(''), [status, setStatus] = useState('');
  const [cursors, setCursors] = useState<string[]>([]), [busyId, setBusyId] = useState(''), [actionError, setActionError] = useState('');
  const timeline = useRef<HTMLDivElement>(null), nearBottom = useRef(true);
  const cursor = cursors[cursors.length - 1];
  const params = new URLSearchParams();
  if (search) params.set('search', search);
  if (type) params.set('type', type);
  if (status) params.set('status', status);
  if (cursor) params.set('before', cursor);
  const { data, error, loading } = useResource<WebHookMessagePage>(`/webhooks/${webhook.id}/messages?${params}`, revision);
  const resetPage = () => { setCursors([]); nearBottom.current = true; setActionError(''); };
  const scrollToLatest = () => { if (nearBottom.current && timeline.current) timeline.current.scrollTop = timeline.current.scrollHeight; };
  useLayoutEffect(scrollToLatest, [data, cursor, loading]);
  const filtered = !!(search || type || status);
  return <section className="webhook-message-view" aria-label={`${webhook.name} 的消息记录`}>
    <div className="webhook-message-heading"><div><strong>消息记录 <span>{data?.total ?? 0}</span></strong><p>按创建时的 Webhooks 归属展示，包含在线测试及历史发送目标。</p></div>{cursor && <Button variant="ghost" icon={RefreshCw} disabled={loading} onClick={resetPage}>回到最新</Button>}</div>
    <div className="webhook-message-filters">
      <div className="search-box"><Search size={15} /><input aria-label="搜索 Webhooks 消息" placeholder="搜索消息内容…" value={search} maxLength={100} onChange={e => { setSearch(e.target.value); resetPage(); }} /></div>
      <select aria-label="消息类型" value={type} onChange={e => { setType(e.target.value); resetPage(); }}><option value="">全部类型</option><option value="text">文本</option><option value="image">图片</option></select>
      <select aria-label="消息状态" value={status} onChange={e => { setStatus(e.target.value); resetPage(); }}><option value="">全部状态</option><option value="queued">排队中</option><option value="sending">发送中</option><option value="provider_accepted">已提交平台</option><option value="failed">发送失败</option><option value="unknown">结果待确认</option></select>
    </div>
    <ErrorLine error={error || actionError} />
    <div className="webhook-message-timeline" role="log" aria-label="Webhooks 发送历史" ref={timeline} onScroll={() => {
      if (timeline.current) nearBottom.current = timeline.current.scrollHeight - timeline.current.scrollTop - timeline.current.clientHeight < 100;
    }}>
      {loading && !data ? <Loading /> : !data?.items.length ? <Empty icon={Webhook} title={filtered ? '没有匹配的消息' : '还没有发送消息'} text={filtered ? '调整关键词、消息类型或状态后再试。' : '通过这个 Webhooks 发送的文本、图片和在线测试消息会显示在这里。'} /> : data.items.map(message => <article className="webhook-message-item" key={message.id}>
        <div className="timeline-time">{fullTime(message.createdAt)}</div>
        <div className="webhook-message-target"><span>{message.botName}{message.botDeleted ? '（已删除）' : ''}</span><ArrowRight size={11} /><strong title={message.peerId}>{message.conversationName}</strong><button disabled={message.botDeleted} title={message.botDeleted ? '原机器人已删除，历史消息仍保留' : '打开消息所在会话'} onClick={() => { navigate('messages', message.botId); onClose(); }}><MessageSquare size={12} />查看会话</button></div>
        <div className="chat-message outgoing"><Avatar name={message.botName} small /><div className="bubble-wrap">
          <div className="bubble-source"><Webhook size={11} />{message.source}</div>
          <div className="bubble">{message.type === 'image' ? message.imageUrl ? <a className="message-image-link" href={message.imageUrl} target="_blank" rel="noreferrer"><img className="message-image" src={message.imageUrl} alt="Webhooks 图片消息，点击查看原图" onLoad={scrollToLatest} /></a> : <span className="image-pending">[图片]{['queued', 'sending'].includes(message.status) ? ' 正在准备…' : ''}</span> : message.text}</div>
          <div className="bubble-status"><Status status={message.status} />{message.status === 'failed' && <button disabled={busyId === message.id} onClick={async () => {
            setBusyId(message.id); setActionError('');
            try { await post(`/messages/${message.id}/retry`); refresh(); }
            catch (error) { setActionError((error as Error).message); }
            finally { setBusyId(''); }
          }}><RefreshCw size={12} />{busyId === message.id ? '提交中…' : '重试'}</button>}</div>
          {message.error && <div className="bubble-error">{message.error}</div>}
          <code className="webhook-message-id">{message.id}</code>
        </div></div>
      </article>)}
    </div>
    <div className="webhook-message-pagination"><span>每页 30 条 · 第 {cursors.length + 1} 页{loading && data ? ' · 更新中…' : ''}</span><div>
      <Button variant="secondary" icon={ChevronLeft} disabled={!data?.nextCursor || loading} onClick={() => { if (data?.nextCursor) { nearBottom.current = true; setCursors(previous => [...previous, data.nextCursor!]); } }}>更早消息</Button>
      <Button variant="secondary" icon={ChevronRight} disabled={!cursor || loading} onClick={() => { nearBottom.current = true; setCursors(previous => previous.slice(0, -1)); }}>更新消息</Button>
    </div></div>
  </section>;
}
