export interface NotificationChannel {
  send(kakaoworkUserId: string, text: string): Promise<{ ok: boolean; error?: string }>;
}
