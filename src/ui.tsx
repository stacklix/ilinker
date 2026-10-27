import { useEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { Check, Copy, Loader2, X, Inbox, type LucideIcon } from 'lucide-react';
import { api } from './api';

export function useResource<T>(path: string | null, revision = 0) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const previous = useRef(path);
  useEffect(() => {
    const controller = new AbortController();
    if (path !== previous.current) { setData(null); previous.current = path; }
    if (!path) { setLoading(false); setData(null); return; }
    setLoading(true); setError('');
    api<T>(path, { signal: controller.signal }).then(value => { if (!controller.signal.aborted) setData(value); })
      .catch(error => { if (!controller.signal.aborted) setError(error.message); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [path, revision]);
  return { data, error, loading, setData };
}

export function Button({ children, icon: Icon, variant = 'primary', busy, className = '', ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { icon?: LucideIcon; variant?: 'primary' | 'secondary' | 'ghost' | 'danger'; busy?: boolean }) {
  return <button className={`btn btn-${variant} ${className}`} {...props} disabled={props.disabled || busy}>
    {busy ? <Loader2 size={16} className="spin" /> : Icon ? <Icon size={16} /> : null}{children}
  </button>;
}
export function IconButton({ icon: Icon, label, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { icon: LucideIcon; label: string }) {
  return <button className="icon-btn" title={label} aria-label={label} {...props}><Icon size={18} /></button>;
}
export function Modal({ title, subtitle, children, onClose, wide = false }: { title: string; subtitle?: string; children: ReactNode; onClose: () => void; wide?: boolean }) {
  const dialog = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose); closeRef.current = onClose;
  useEffect(() => {
    const active = document.activeElement as HTMLElement | null;
    const container = dialog.current;
    container?.focus();
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeRef.current();
      if (event.key === 'Tab' && container) {
        const nodes = [...container.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled),[tabindex="0"]')];
        if (!nodes.length) { event.preventDefault(); return; }
        const first = nodes[0], last = nodes[nodes.length - 1];
        if (event.shiftKey && (document.activeElement === first || document.activeElement === container)) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && (document.activeElement === last || document.activeElement === container)) { event.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener('keydown', handler);
    return () => { document.removeEventListener('keydown', handler); active?.focus(); };
  }, []);
  return <div className="modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
    <div className={`modal ${wide ? 'modal-wide' : ''}`} role="dialog" aria-modal="true" aria-label={title} ref={dialog} tabIndex={-1}>
      <div className="modal-header"><div><h2>{title}</h2>{subtitle && <p>{subtitle}</p>}</div><IconButton icon={X} label="关闭" onClick={onClose} /></div>
      {children}
    </div>
  </div>;
}
export function Empty({ icon: Icon = Inbox, title, text, action }: { icon?: LucideIcon; title: string; text: string; action?: ReactNode }) {
  return <div className="empty"><div className="empty-icon"><Icon size={27} strokeWidth={1.5} /></div><h3>{title}</h3><p>{text}</p>{action}</div>;
}
export function ErrorLine({ error }: { error?: string }) { return error ? <div className="error-line" role="alert">{error}</div> : null; }
export function Loading() { return <div className="loading"><Loader2 size={20} className="spin" />加载中</div>; }
export function Avatar({ name, small = false, square = false }: { name: string; small?: boolean; square?: boolean }) {
  const sum = [...name].reduce((total, c) => total + c.charCodeAt(0), 0);
  return <span className={`avatar avatar-${sum % 5} ${small ? 'avatar-small' : ''} ${square ? 'avatar-square' : ''}`}>{name.slice(0, 1).toUpperCase()}</span>;
}
const botLabels: Record<string, string> = { pending: '待登录', logging_in: '登录中', connecting: '连接中', online: '在线', reconnecting: '重连中', expired: '授权失效', stopped: '已停止' };
const messageLabels: Record<string, string> = { queued: '排队中', sending: '发送中', provider_accepted: '已提交平台', failed: '发送失败', unknown: '结果待确认', received: '已接收', rejected: '请求被拒绝' };
export function Status({ status, bot = false }: { status: string; bot?: boolean }) {
  return <span className={`status status-${status}`}><i />{(bot ? botLabels : messageLabels)[status] || status}</span>;
}
export function CopyButton({ text, label = '复制' }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  return <Button variant="secondary" icon={copied ? Check : Copy} onClick={async () => {
    try { await navigator.clipboard.writeText(text); setCopied(true); setFailed(false); setTimeout(() => setCopied(false), 2000); }
    catch { setFailed(true); }
  }}>{copied ? '已复制' : failed ? '请手动选择复制' : label}</Button>;
}
export function relative(time: number | null) {
  if (!time) return '暂无';
  const seconds = Math.max(0, (Date.now() - time) / 1000);
  if (seconds < 60) return '刚刚'; if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时前`;
  return new Date(time).toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' });
}
export const fullTime = (time: number) => new Date(time).toLocaleString('zh-CN', { hour12: false });
export const conversationName = (c: { remark: string; name: string }) => c.remark || c.name;
