export class ApiError extends Error {
  constructor(message: string, public code: string, public status: number) { super(message); }
}
export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(path.startsWith('/api/') ? path : `/api/v1${path}`, {
    ...options, credentials: 'same-origin',
    headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers },
  });
  const data = await response.json();
  if (!response.ok) {
    if (response.status === 401 && !path.includes('/auth/login')) window.dispatchEvent(new Event('unauthorized'));
    throw new ApiError(data.message || '请求失败', data.code || 'REQUEST_ERROR', response.status);
  }
  return data as T;
}
export const post = <T>(path: string, body?: unknown) => api<T>(path, { method: 'POST', ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
export const patch = <T>(path: string, body: unknown) => api<T>(path, { method: 'PATCH', body: JSON.stringify(body) });
export const remove = (path: string) => api(path, { method: 'DELETE' });
