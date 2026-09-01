// employees.kakaowork_user_id를 채우는 경로. 이 파일이 그 값을 쓰는 **유일한** 곳이다.
//
// 옛 시스템에서는 매직링크 로그인(supabase/functions/auth-kakaowork/index.ts:96-116)이
// 로그인마다 회사 이메일로 카카오워크 user id를 조회해 employees 행에 채웠다 —
// 로그인 자체가 연결 절차였다. 매직링크를 비밀번호 인증으로 바꾸면서 그 함수가
// 폐기됐고, 대체 경로가 만들어지지 않았다. 그 결과 이관된 시스템에는 이 컬럼을
// 채우는 길이 하나도 없었고, 모든 알림 경로(jobs/common.ts의 alertRecipientKakaoIds,
// jobs/send.ts, jobs/weatherTick.ts의 관리자 경보)가 `kakaowork_user_id is not null`로
// 거르기 때문에 **특보를 감지해도 아무에게도 전달되지 않았다** — 그런데 화면·health·
// 워치독·컨테이너 상태가 전부 초록이었다.
//
// 여기서 되살리는 것은 그 옛 동작이다: 회사 이메일로 조회해 채운다. 다만 붙는 자리가
// 로그인이 아니라 (1) 가입, (2) 관리자의 직원 등록, (3) 이메일 수정, (4) 하루 한 번
// 미연결자 재시도(jobs/kakaoLinkTick.ts)다.
//
// **이 모듈의 함수는 절대 던지지 않는다.** 카카오워크 조회가 실패했다고 가입이나
// 직원 등록이 실패하면 안 된다 — DM으로 닿을 수 없는 사람도 시스템에는 들어와야 한다.
// 실패는 값이 null로 남고 로그에 남는 것으로 끝나고, 그 사실은 셋업 체크리스트·
// /api/health/deep·워치독이 따로 보여 준다(그쪽이 이 파일보다 중요하다).
import { resolveKakaoworkUserIdByEmail } from "./shared/kakaowork.ts";
import { withService } from "./db.ts";

/** shared/kakaowork.ts의 조회 함수와 같은 모양. 테스트에서만 갈아 끼운다. */
export type Resolver = (botKey: string, email: string) => Promise<string | null>;

/** 봇 키가 없으면 조회 자체가 불가능하다(설치 직후·시연 모드). null을 돌려준다. */
function botKey(): string | null {
  const key = process.env.KAKAOWORK_BOT_KEY;
  return key ? key : null;
}

export type LinkResult = { linked: string | null; reason: "ok" | "no-bot-key" | "not-found" | "error" };

/**
 * 회사 이메일로 카카오워크 user id를 조회해 employees 행에 채운다.
 * 이미 값이 있으면 덮어쓴다(이메일이 바뀌었거나 계정이 새로 만들어진 경우가 있다).
 * 어떤 이유로 실패하든 던지지 않고 이유를 돌려준다.
 */
export async function linkKakaoworkUserId(
  email: string,
  deps: { resolve?: Resolver; botKey?: string | null } = {},
): Promise<LinkResult> {
  const key = deps.botKey !== undefined ? deps.botKey : botKey();
  if (!key) {
    console.warn(`[kakaowork] 봇 키가 없어 ${email}의 카카오워크 연결을 건너뜁니다`);
    return { linked: null, reason: "no-bot-key" };
  }
  const resolve = deps.resolve ?? resolveKakaoworkUserIdByEmail;
  let id: string | null = null;
  try {
    id = await resolve(key, email);
  } catch (e) {
    // 네트워크·파싱 오류. 가입·등록을 막지 않는다.
    console.error(`[kakaowork] ${email} 조회 실패:`, e);
    return { linked: null, reason: "error" };
  }
  if (!id) {
    // 카카오워크에 그 이메일 계정이 없다(오타·미가입·퇴사). 사람은 시스템에 들어오되
    // DM은 못 받는 상태로 남는다 — 그 사실은 화면과 상태 점검이 보여 준다.
    console.warn(`[kakaowork] ${email}에 해당하는 카카오워크 사용자를 찾지 못했습니다`);
    return { linked: null, reason: "not-found" };
  }
  try {
    await withService((q) =>
      q.query("update employees set kakaowork_user_id = $2 where lower(email) = lower($1)", [email, id]),
    );
  } catch (e) {
    console.error(`[kakaowork] ${email}의 연결 저장 실패:`, e);
    return { linked: null, reason: "error" };
  }
  return { linked: id, reason: "ok" };
}

/**
 * 아직 연결되지 않은 직원 전부를 다시 시도한다.
 *
 * 이 함수가 필요한 이유: 연결이 안 되는 흔한 원인들이 **나중에 고쳐진다.** 설치 직후에는
 * 봇 키가 아직 없고(.env를 채우기 전), 카카오워크 계정이 직원보다 늦게 만들어지기도 하고,
 * 관리자가 이메일 오타를 며칠 뒤에 고친다. 가입·등록 시점 한 번만 시도하면 그 사람들은
 * 영원히 미연결로 남는다.
 */
export async function relinkUnlinked(
  deps: { resolve?: Resolver; botKey?: string | null; limit?: number } = {},
): Promise<{ candidates: number; linked: number }> {
  const key = deps.botKey !== undefined ? deps.botKey : botKey();
  if (!key) {
    console.warn("[kakaowork] 봇 키가 없어 미연결 직원 재시도를 건너뜁니다");
    return { candidates: 0, linked: 0 };
  }
  const emails = await withService(async (q) => {
    const { rows } = await q.query(
      `select email from employees
        where kakaowork_user_id is null and email is not null
        order by email limit $1`,
      [deps.limit ?? 500],
    );
    return rows.map((r: { email: string }) => r.email);
  });
  let linked = 0;
  for (const email of emails) {
    const out = await linkKakaoworkUserId(email, { resolve: deps.resolve, botKey: key });
    if (out.linked) linked++;
  }
  if (emails.length > 0) {
    console.log(`[kakaowork] 미연결 ${emails.length}명 재시도 → ${linked}명 연결`);
  }
  return { candidates: emails.length, linked };
}

/**
 * Alert 수신자 중 몇 명이 실제로 카카오워크에 연결돼 있는지 센다.
 * 이 값이 0이면 특보 승인 요청이 아무에게도 가지 않는다 — 상태 점검(watchdog)과
 * 화면(셋업 체크리스트·알림 설정)이 같은 사실을 이 함수 하나로 본다.
 */
export async function alertRecipientLinkCounts(
  q: { query: (text: string, params?: unknown[]) => Promise<{ rows: any[] }> },
): Promise<{ total: number; linked: number }> {
  const { rows } = await q.query(
    `select count(*)::int as total, count(e.kakaowork_user_id)::int as linked
       from alert_recipients ar join employees e on e.id = ar.employee_id`,
  );
  return { total: rows[0].total as number, linked: rows[0].linked as number };
}
