export type BotStatus = 'pending' | 'logging_in' | 'connecting' | 'online' | 'reconnecting' | 'expired' | 'stopped';
export type MessageStatus = 'received' | 'queued' | 'sending' | 'provider_accepted' | 'failed' | 'unknown';
export interface Bot {
  id: string; name: string; platform: string; status: BotStatus; note: string;
  accountId: string | null; lastError: string | null; lastSeenAt: number | null;
  createdAt: number; hasCredentials: boolean; unread: number; webhookCount: number;
  conversationId: string | null; conversationName: string | null;
}
export interface Conversation {
  id: string; botId: string; peerId: string; name: string; remark: string;
  unread: number; lastMessage: string;
  lastMessageAt: number; hasContext: boolean;
}
export interface Message {
  id: string; botId: string; conversationId: string; direction: 'in' | 'out';
  type: string; text: string; status: MessageStatus; source: string;
  webhookId: string | null; error: string | null; createdAt: number; updatedAt: number;
  imageUrl?: string | null;
}
export interface WebHookMessage extends Message {
  botName: string; conversationName: string; peerId: string; botDeleted: boolean;
}
export interface WebHookMessagePage {
  items: WebHookMessage[]; nextCursor: string | null; total: number;
}
export interface WebHook {
  id: string; name: string; botId: string; conversationId: string | null; enabled: boolean;
  tokenHint: string; rateLimit: number; expiresAt: number | null; createdAt: number;
  botName: string; conversationName: string | null; requestCount: number; failureCount: number; lastUsedAt: number | null;
}
export interface WebHookRequest {
  id: string; webhookId: string; messageId: string | null; status: string;
  summary: string; error: string | null; ip: string; createdAt: number;
}
export interface LoginSession {
  id: string; botId: string; status: string; qrImage: string; qrContent: string; expiresAt: number; error: string | null;
}
export interface BotLog { id: string; level: string; event: string; detail: string; createdAt: number }
export interface Overview {
  bots: number; onlineBots: number; receivedToday: number; sentToday: number;
  failedToday: number; queued: number; webhooks: number;
  recentMessages: (Message & { botName: string; conversationName: string })[];
  activity: { date: string; incoming: number; outgoing: number }[];
}
