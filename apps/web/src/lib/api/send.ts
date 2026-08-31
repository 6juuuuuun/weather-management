// server/src/index.ts의 POST /api/send에 대응한다.
//
// 예전에는 supabase.functions.invoke("send")를 불렀다 — 화면에 남아 있던 마지막
// Supabase 의존이었다. Edge Function이 하던 일은 server/src/jobs/send.ts로 그대로
// 옮겨졌고(권한 검사 두 가지 포함), 화면은 이제 같은 출처의 /api/send만 부른다.
//
// 이 모듈이 lib/api/ 밑으로 들어온 이유: 예전 위치인 lib/api.ts는 lib/api/ 디렉터리와
// 이름이 겹쳐, 같은 `../lib/api` 임포트가 파일과 디렉터리 중 무엇을 가리키는지
// 한눈에 알 수 없었다. 나머지 리소스 모듈(dashboard/org/content/auth)과 같은 자리에 둔다.
import { apiSend } from "./client";
import type { DeptBlock } from "../types";

export type SendBody =
  | { mode: "approve"; event_id: string; content: DeptBlock[] }
  | { mode: "resend"; message_id: string; content: DeptBlock[] }
  | { mode: "dismiss"; event_id: string }
  | { mode: "test" };

export type SendResult = {
  ok: boolean;
  dispatch_id?: number;
  repeat_no?: number;
  obs_line?: string;
  fail_count?: number;
  error?: string;
};

// client.ts는 HTTP 오류(403 권한·409 상태 충돌 등)에 throw한다 — supabase-js처럼
// {data, error}로 resolve하지 않는다. 호출부 셋(Settings의 테스트 발송, EventReview의
// 승인/무시, History의 재발송)은 모두 catch로 메시지를 띄우고 로딩 상태를 풀어야 한다.
// 200에 { ok:false, error }가 실려 오는 경우도 있다(테스트 발송이 채널에서 실패한 경우) —
// 그래서 호출부는 throw와 ok:false 둘 다 다뤄야 한다.
export const callSend = (body: SendBody) => apiSend<SendResult>("POST", "/api/send", body);
