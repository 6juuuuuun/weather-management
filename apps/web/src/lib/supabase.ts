import { createClient } from "@supabase/supabase-js";

/**
 * 빌드 시 VITE_* 변수가 주입되지 않으면 createClient가 "supabaseUrl is required"로
 * 던지고, 화면에는 아무것도 렌더되지 않는다(흰 화면). 원인이 콘솔에만 남아
 * 운영에서 진단이 어려우므로, 여기서 설정 누락을 명시적으로 구분해 던진다.
 * main.tsx가 이 에러를 잡아 사람이 읽을 수 있는 안내 화면을 띄운다.
 */
export class MissingConfigError extends Error {
  readonly missing: string[];

  constructor(missing: string[]) {
    super(`환경변수 누락: ${missing.join(", ")}`);
    this.name = "MissingConfigError";
    this.missing = missing;
  }
}

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

const missing = [
  ["VITE_SUPABASE_URL", url],
  ["VITE_SUPABASE_ANON_KEY", anonKey],
]
  .filter(([, v]) => !v)
  .map(([k]) => k as string);

if (missing.length > 0) throw new MissingConfigError(missing);

export const supabase = createClient(url, anonKey);
