import { supabase } from "./supabase";
import type { DeptBlock } from "./types";

export type SendBody =
  | { mode: "approve"; event_id: string; content: DeptBlock[] }
  | { mode: "resend"; message_id: string; content: DeptBlock[] }
  | { mode: "dismiss"; event_id: string }
  | { mode: "test" };

export type SendResult = {
  ok: boolean;
  dispatch_id?: number;
  fail_count?: number;
  error?: string;
};

export async function callSend(body: SendBody): Promise<SendResult> {
  const { data, error } = await supabase.functions.invoke("send", { body });
  if (error) throw error;
  return data as SendResult;
}
