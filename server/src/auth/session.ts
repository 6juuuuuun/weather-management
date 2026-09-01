import { createHash, randomBytes } from "node:crypto";
import { withService } from "../db.ts";

// 세션은 **활동이 끊긴 뒤** 이만큼 지나면 만료된다(고정 만료가 아니라 슬라이딩
// 만료다 — 요청이 들어올 때마다 만료 시각을 다시 민다).
//
// 왜 슬라이딩인가(QA W-14 · 결정 D-4): 벽걸이 월보드는 사람이 없는 관제실 화면인데
// 고정 12시간 만료 때문에 **하루 두 번 누가 걸어가서 로그인해야 했고**, 꺼지는
// 시각은 마지막 로그인 시각에 따라 제멋대로였다(새벽 3시에 로그인 폼이 걸린 채로
// 아침을 맞는다). 월보드는 30초마다 폴링하므로 슬라이딩이면 켜져 있는 한 살아 있다.
// 덤으로 일반 사용자도 일하는 도중에 12시간 벽에 걸려 튕겨 나가지 않는다.
//
// 왜 8시간인가: 기존 고정 TTL(12시간)보다 **짧다** — 자리를 뜬 채 방치된 화면이나
// 도난당한 노트북이 살아 있는 시간은 늘지 않고 줄었다. 동시에 근무 중 생길 수 있는
// 어떤 공백(회의·식사·야간 근무의 한산한 시간)보다 길어서 일하는 사람을 끊지 않고,
// 퇴근 시각에 켜 둔 채 나간 화면은 다음 근무조가 오기 전에 만료된다.
// 상한(absolute cap)은 두지 않는다 — 두면 월보드가 결국 그 시각에 꺼지고,
// 이 결정의 목적 자체가 사라진다.
const IDLE_TTL_HOURS = 8;

/** 로그인 쿠키의 maxAge. DB의 만료와 반드시 같은 값이어야 한다 — 쿠키가 먼저
 *  죽으면 DB 세션이 아무리 살아 있어도 브라우저가 토큰을 안 보낸다. */
export const SESSION_COOKIE_MAX_AGE_MS = IDLE_TTL_HOURS * 60 * 60 * 1000;

// 만료가 이만큼 가까워졌을 때만 실제로 민다. 이게 없으면 요청 한 건마다 update가
// 한 번씩 나간다(월보드만 해도 30초에 한 번). 5분이면 30초 폴링 열 번에 한 번이다.
const SLIDE_WHEN_REMAINING_UNDER_MIN = IDLE_TTL_HOURS * 60 - 5;

const hashToken = (t: string) => createHash("sha256").update(t).digest("hex");

/**
 * 쿠키의 원문 토큰을 DB에 저장된 형태로 바꾼다. 세션을 "지금 이 세션만 빼고"
 * 지우는 곳(auth/routes.ts의 change-password)이 필요로 한다 — 해시 함수를 그쪽에
 * 복사하면 두 정의가 언젠가 어긋나고, 어긋나면 조용히 **현재 세션까지 지워진다**.
 */
export const tokenHash = (token: string): string => hashToken(token);

/** 원문 토큰을 돌려주고 DB에는 해시만 남긴다. */
export async function issue(accountId: string): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  await withService((q) =>
    q.query(
      `insert into auth_sessions (token_hash, account_id, expires_at)
       values ($1, $2, now() + ($3 || ' hours')::interval)`,
      [hashToken(token), accountId, String(IDLE_TTL_HOURS)],
    ),
  );
  return token;
}

export type SessionUser = {
  accountId: string;
  employeeId: string | null;
  role: string | null;
  email: string;
  mustChangePassword: boolean;
  /** 이번 조회에서 만료 시각을 실제로 밀었는가. 밀었을 때만 쿠키를 다시 심는다. */
  slid?: boolean;
};

/**
 * 토큰으로 세션 주인을 찾고, 동시에 만료 시각을 앞으로 민다(슬라이딩 만료).
 *
 * 조회와 연장을 **한 문장 안에서** 한다. 두 번 왕복하면 그 사이에 만료된 세션을
 * 되살리는 창이 생기고, 요청마다 DB 왕복이 하나 더 는다. 연장은 만료가
 * 5분 안쪽으로 다가왔을 때만 일어난다(update가 실제로 행을 건드렸는지는
 * `slid`로 돌려준다 — 라우터가 그때만 쿠키를 다시 심는다).
 */
export async function lookup(token: string): Promise<SessionUser | null> {
  return withService(async (q) => {
    const { rows } = await q.query(
      `with live as (
         select s.token_hash, a.id, a.email, a.must_change_password,
                e.id as employee_id, e.role
           from auth_sessions s
           join auth_accounts a on a.id = s.account_id
           left join employees e on e.auth_user_id = a.id
          where s.token_hash = $1 and s.expires_at > now() and a.status = 'active'
       ),
       slid as (
         update auth_sessions
            set expires_at = now() + ($2 || ' hours')::interval
          where token_hash = (select token_hash from live)
            and expires_at < now() + ($3 || ' minutes')::interval
         returning 1
       )
       select live.*, (select count(*) from slid) > 0 as slid from live`,
      [hashToken(token), String(IDLE_TTL_HOURS), String(SLIDE_WHEN_REMAINING_UNDER_MIN)],
    );
    if (rows.length === 0) return null;
    return {
      accountId: rows[0].id,
      employeeId: rows[0].employee_id ?? null,
      role: rows[0].role ?? null,
      email: rows[0].email,
      mustChangePassword: rows[0].must_change_password,
      slid: rows[0].slid === true,
    };
  });
}

export async function revoke(token: string): Promise<void> {
  await withService((q) => q.query("delete from auth_sessions where token_hash = $1", [hashToken(token)]));
}

/** 만료된 세션을 치운다. 스케줄러가 하루 한 번 부른다. */
export async function purgeExpired(): Promise<number> {
  return withService(async (q) => {
    const { rows } = await q.query("delete from auth_sessions where expires_at <= now() returning 1");
    return rows.length;
  });
}
