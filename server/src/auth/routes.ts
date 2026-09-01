import { Router } from "express";
import { randomBytes } from "node:crypto";
import { withService, UUID } from "../db.ts";
import { hash, verify, temporaryPassword } from "./password.ts";
import { issue, lookup, revoke, tokenHash } from "./session.ts";
import { COOKIE, requireAuth, requireAdmin } from "./middleware.ts";
import { isAllowedEmailDomain, isValidEmailShape } from "./emailDomain.ts";
import { linkKakaoworkUserId } from "../kakaoLink.ts";

const MAX_ATTEMPTS = 5;
const LOCK_MINUTES = 15;
// 임시 비밀번호의 유효 시간(스펙 §6.4). 관리자가 발급해 당사자에게 직접 전달하는
// 값이라, 주말을 끼고 전달되는 경우까지 감안해 3일로 둔다. 이보다 길면 "발급해
// 두고 잊은" 임시 비밀번호가 관리자만 아는 상시 백도어가 된다 — 관리자는 발급한
// 값을 알고 있으므로, 그 계정이 Alert 수신자라면 특보 승인 권한까지 인수할 수 있다.
const TEMP_PASSWORD_HOURS = 72;
// 비밀번호 최소 길이. 화면(apps/web의 Signup.tsx·ChangePassword.tsx)에도 같은 값이
// 각각 하드코딩돼 있다 — 웹과 서버는 별개 npm 패키지라 상수를 공유할 자연스러운
// 통로가 없다. 무리하게 구조를 만드는 대신 export해서 세 값이 어긋나면 실패하는
// 테스트로 묶는다(server/test/auth.test.ts의 "비밀번호 최소 길이"). 서버가
// 최종 관문이므로, 화면 검사가 없어도 여기서 반드시 막힌다.
export const MIN_PASSWORD = 10;

// 없는 계정으로 로그인을 시도했을 때 쓰는 더미 해시(QA W-28). 아무도 모르는 임의
// 값을 한 번만 해싱해 두고 재사용한다 — 원문을 알 수 없으니 이 해시로는 어떤
// 비밀번호도 통과하지 못하고, 검증 비용(argon2)만 실재 계정과 같아진다.
// 프로세스 기동 시점이 아니라 첫 실패 로그인 때 한 번 계산한다(기동을 늦추지 않는다).
let dummyHashPromise: Promise<string> | null = null;
function dummyHash(): Promise<string> {
  dummyHashPromise ??= hash(randomBytes(32).toString("base64url"));
  return dummyHashPromise;
}

export const authRouter = Router();

authRouter.post("/signup", async (req, res) => {
  const { password, name, department_id, phone } = req.body ?? {};
  const emailRaw = req.body?.email;
  if (!emailRaw || !password || !name) return res.status(400).json({ error: "필수 항목이 비어 있습니다" });

  // 가입에도 변경(change-password)과 같은 최소 길이를 적용한다. 예전에는 !password만
  // 봤기 때문에 브라우저를 거치지 않는 요청이 1자 비밀번호로 가입하고 그대로 로그인할 수
  // 있었다 — 화면의 10자 검사는 우회할 수 있으므로 방벽이 아니다. 그 계정이 나중에
  // Alert 수신자가 되면 1자 비밀번호가 특보 승인 권한을 지키게 된다.
  if (typeof password !== "string" || password.length < MIN_PASSWORD) {
    return res.status(400).json({ error: `비밀번호는 ${MIN_PASSWORD}자 이상이어야 합니다` });
  }

  // 이메일 대소문자를 정규화한다. 그대로 두면 Kim@과 kim@이 서로 다른 계정·직원
  // 행으로 갈라져 같은 사람이 명부에 두 번 오르고, 부서 수신자 목록에도 중복으로
  // 들어가 특보가 두 번 나가는 등 발송 대상이 어긋난다.
  const email = String(emailRaw).trim().toLowerCase();

  // 형식과 도메인을 **다른 문구로** 가른다(QA W-20). 예전에는 둘이 한 검사에
  // 묶여 있어서, @가 없는 값을 넣으면 도메인 제한을 켜지도 않은 서버가
  // "회사 이메일로만 가입할 수 있습니다"라고 답했다 — 원인을 정확히 반대로
  // 가리키는 문구다. 형식이 먼저다: 형식이 깨진 값은 도메인을 볼 수조차 없다.
  if (!isValidEmailShape(email)) {
    return res.status(400).json({ error: "이메일 형식이 올바르지 않습니다" });
  }
  if (!isAllowedEmailDomain(email)) {
    return res.status(400).json({ error: "회사 이메일로만 가입할 수 있습니다" });
  }

  try {
    await withService(async (q) => {
      const { rows } = await q.query(
        "insert into auth_accounts (email, password_hash) values ($1, $2) returning id",
        [email, await hash(password)],
      );
      // 가입과 동시에 직원 레코드를 만든다. 권한은 staff이고 관리자가 나중에 올린다.
      // 관리자가 부서 배정을 위해 미리 employees 행을 만들어 둔 경우(로그인 계정은
      // 아직 없음)를 대비해 email이 이미 있으면 그 행에 계정을 이어 붙인다(upsert).
      // role은 갱신하지 않는다 — 이미 admin으로 올라간 행(또는 관리자가 미리
      // approver로 지정해 둔 행)이 재가입으로 staff로 강등되면 안 된다. 실제 관문은
      // 관리자의 역할 부여이지 가입이 아니다. name만 coalesce 없이 그대로 덮어쓰는
      // 이유는 name이 가입 필수값이라 excluded.name이 null일 수 없고, 본인이 지금
      // 입력한 이름이 관리자가 미리 적어 둔 이름보다 정확하다고 보기 때문이다.
      //
      // do update에 `where employees.auth_user_id is null`을 단다(QA W-01g). 이 조건이
      // 없으면 **이미 다른 사람의 로그인 계정이 붙어 있는 직원 행**까지 새 계정이
      // 인수한다. 실제 경로가 있었다: 관리자가 직원 이메일만 고치면 명부와 계정이
      // 갈라지고(그 자체는 아래 PATCH /api/employees에서 막았다), 비워진 새 이메일로
      // 제3자가 가입하면 원래 직원 행의 부서·역할을 통째로 물려받았다 — role은 SET
      // 절에 없어 **원래 사람의 역할(승인권자 포함)이 그대로 새 계정에 붙었다.**
      // 원래 사람은 role: null 유령이 되어 계속 로그인했다.
      // 두 겹으로 막는다: 갈라지지 않게 하고(PATCH), 갈라져 있더라도 인수는 막는다.
      const { rows: merged } = await q.query(
        `insert into employees (auth_user_id, name, email, phone, department_id, role)
         values ($1, $2, $3, $4, $5, 'staff')
         on conflict (email) do update
           set auth_user_id = excluded.auth_user_id,
               name = excluded.name,
               phone = coalesce(excluded.phone, employees.phone),
               department_id = coalesce(excluded.department_id, employees.department_id)
           where employees.auth_user_id is null
         returning id`,
        [rows[0].id, name, email, phone ?? null, department_id ?? null],
      );
      // where가 걸리면 아무 행도 돌아오지 않는다. 그대로 두면 계정만 만들어지고
      // 직원 행이 없는 반쪽 상태(= 유령 계정)가 커밋된다 — 지금 고치고 있는 바로
      // 그 상태다. 던져서 트랜잭션을 통째로 되돌린다.
      if (merged.length === 0) throw new Error("EMPLOYEE_ALREADY_LINKED");
    });
  } catch (e: any) {
    if (e?.message === "EMPLOYEE_ALREADY_LINKED") {
      return res.status(409).json({
        error: "이 이메일은 이미 다른 로그인 계정에 연결돼 있습니다. 관리자에게 문의해 주세요",
      });
    }
    if (e?.code === "23505") return res.status(409).json({ error: "이미 가입된 이메일입니다" });
    throw e;
  }
  // 옛 시스템에서는 매직링크 로그인이 곧 카카오워크 연결이었다(supabase/functions/
  // auth-kakaowork). 그 절차가 사라지면서 이 값을 채우는 경로가 시스템에 하나도 남지
  // 않았고, 모든 알림이 0명에게 갔다. 가입이 그 자리를 대신한다.
  // linkKakaoworkUserId는 절대 던지지 않는다 — 봇 키가 없거나 조회가 실패해도
  // 가입 자체는 성공해야 한다. DM으로 닿을 수 없는 사람도 시스템에는 들어와야 한다.
  await linkKakaoworkUserId(email);
  res.status(201).json({ ok: true });
});

authRouter.post("/login", async (req, res) => {
  const { password } = req.body ?? {};
  const email = String(req.body?.email ?? "").trim().toLowerCase();
  const account = await withService(async (q) => {
    const { rows } = await q.query(
      // 잠금 만료 여부를 Postgres가 직접 계산해 내려준다. locked_until은 Postgres
      // 시계로 쓰이므로(now() + interval) Node의 new Date()로 비교하면 두 시계가
      // 어긋난 만큼 판정이 틀린다 — 시계 도메인을 하나로 묶는다.
      `select id, password_hash, status, failed_attempts, must_change_password,
              (locked_until is not null and locked_until > now()) as is_locked,
              -- 남은 잠금 시간을 분으로 함께 내려준다(QA W-18). 화면이 "몇 분 뒤에
              -- 다시" 를 말할 수 있어야 한다 — 그 정보가 매뉴얼에만 있으면 잠긴
              -- 사람은 못 본다. 올림이라 0분이 나오지 않는다(1분 미만도 "1분").
              greatest(1, ceil(extract(epoch from (locked_until - now())) / 60))::int
                as locked_minutes,
              (must_change_password
                 and temp_password_expires_at is not null
                 and temp_password_expires_at <= now()) as temp_expired
         from auth_accounts where email = $1`,
      [email],
    );
    return rows[0] ?? null;
  });

  // 계정이 없을 때와 비밀번호가 틀렸을 때의 응답을 같게 유지한다.
  // 다르면 어떤 이메일이 가입돼 있는지 캐낼 수 있다.
  const deny = () => res.status(401).json({ error: "로그인할 수 없습니다" });
  if (!account) {
    // 문구는 같아도 **시간이 달랐다**(QA W-28). 없는 계정은 argon2 검증을 통째로
    // 건너뛰어 즉시 401이 나가고, 있는 계정은 해시 검증만큼(수십 ms) 늦게 나간다 —
    // 위 주석이 막으려던 "어떤 이메일이 가입돼 있는지 캐내기"가 시간 축에서 그대로
    // 열려 있었다. 더미 해시로 같은 비용을 치른다.
    await verify(await dummyHash(), String(password ?? ""));
    return deny();
  }

  if (account.is_locked) {
    // 로그인 실패와 잠금이 같은 문구("잠시 후 다시 시도해 주세요")로 나가던 것을
    // 가른다(QA W-18). 사용자는 비밀번호를 계속 틀렸다고 믿고 계속 시도해 잠금을
    // 연장했다. 계정 존재 여부는 이 응답(423)이 이미 드러내고 있던 것이라 새로
    // 흘리는 정보는 없다 — 사내망 전용 전제에서 사용성을 택한다.
    return res.status(423).json({
      error: `비밀번호를 ${MAX_ATTEMPTS}회 잘못 입력해 계정이 잠겼습니다. ` +
        `약 ${account.locked_minutes}분 뒤에 다시 시도하거나 관리자에게 문의해 주세요`,
      locked_minutes: account.locked_minutes,
    });
  }

  if (!(await verify(account.password_hash, String(password ?? "")))) {
    const locked = await withService(async (q) => {
      const { rows } = await q.query(
        // 잠금이 이미 만료된 상태(locked_until이 과거)라면 실패 횟수를 이어 올리지
        // 않고 1부터 다시 센다. 그냥 이어 올리면(성공해야만 0으로 돌아가는데 잠긴
        // 동안은 성공할 수 없으므로) 잠금이 풀린 직후 딱 한 번만 틀려도
        // failed_attempts(이미 5 이상) + 1 >= 5가 다시 참이 되어 계속 재잠금된다 —
        // 이메일만 알면 그 계정을 사실상 영원히 잠글 수 있는 구멍이다. 이 시스템에서
        // 그 대상이 특보 승인권자라면, 실제 경보 발생 시 승인 자체가 막히는
        // 문제로 이어진다.
        `update auth_accounts a
            set failed_attempts = t.next_failed,
                locked_until = case when t.next_failed >= $2
                               then now() + ($3 || ' minutes')::interval else null end,
                -- 잠금이 실제로 걸리는 순간에만 누적 횟수를 올린다(QA W-17). 한 번은
                -- 사람이 비밀번호를 잊은 것이고 열 번은 누가 그 계정을 겨냥하고
                -- 있다는 뜻인데, locked_until 한 값만으로는 그 둘을 구분할 수 없다.
                -- 관리자 화면(직원 관리)이 이 값을 그대로 보여 준다.
                lock_count = case when t.next_failed >= $2 then lock_count + 1 else lock_count end,
                last_locked_at = case when t.next_failed >= $2 then now() else last_locked_at end
           from (
             select id,
                    case when locked_until is not null and locked_until <= now()
                         then 1
                         else failed_attempts + 1
                    end as next_failed
               from auth_accounts
              where id = $1
           ) t
          where a.id = t.id
        returning a.lock_count, (a.locked_until is not null and a.locked_until > now()) as is_locked`,
        [account.id, MAX_ATTEMPTS, String(LOCK_MINUTES)],
      );
      return rows[0] ?? null;
    });
    // 로그에도 남긴다 — 운영 안내서가 "로그 마지막 몇 줄에 답이 있다"고 안내하는데,
    // 반복 잠금은 지금까지 로그에 흔적이 하나도 없었다. 관리자가 화면을 보고 있지
    // 않아도 나중에 되짚을 수 있어야 한다.
    if (locked?.is_locked) {
      console.warn(`[auth] 계정 잠금: ${email} (누적 ${locked.lock_count}회, ${LOCK_MINUTES}분)`);
    }
    return deny();
  }

  if (account.status !== "active") {
    return res.status(403).json({ error: "사용할 수 없는 계정입니다. 관리자에게 문의해 주세요" });
  }

  // 임시 비밀번호는 만료된다(스펙 §6.4). 비밀번호 검증 뒤에 본다 — 앞에 두면
  // 어떤 계정이 임시 비밀번호 상태인지 비밀번호 없이 알아낼 수 있다.
  // 만료된 값으로는 세션을 아예 만들지 않는다: must_change_password 게이트는
  // API 접근만 막고 로그인과 비밀번호 변경은 허용하므로, 그것만으로는
  // "몇 달 뒤 그 값으로 들어와 비밀번호를 바꿔 계정을 인수"하는 길이 그대로 열린다.
  if (account.temp_expired) {
    return res.status(403).json({
      error: "임시 비밀번호가 만료되었습니다. 관리자에게 다시 발급을 요청해 주세요",
    });
  }

  await withService((q) =>
    q.query("update auth_accounts set failed_attempts = 0, locked_until = null where id = $1", [account.id]),
  );

  const token = await issue(account.id);
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.COOKIE_SECURE === "true",
    maxAge: 12 * 60 * 60 * 1000,
  });
  const user = await lookup(token);
  res.json({ user, must_change_password: account.must_change_password });
});

authRouter.post("/logout", async (req, res) => {
  const token = req.cookies?.[COOKIE];
  if (token) await revoke(token);
  res.clearCookie(COOKIE);
  res.status(204).end();
});

authRouter.get("/me", requireAuth, (req, res) => res.json({ user: req.user }));

authRouter.post("/change-password", requireAuth, async (req, res) => {
  const { current, next } = req.body ?? {};
  if (typeof next !== "string" || next.length < MIN_PASSWORD) {
    return res.status(400).json({ error: `비밀번호는 ${MIN_PASSWORD}자 이상이어야 합니다` });
  }
  // 같은 값으로의 "변경"을 거부한다(QA W-05a). 예전에는 쪽지에 적힌 임시 비밀번호를
  // 그대로 두 칸에 옮겨 적으면 204가 나갔고, 비밀번호는 임시 값 그대로인데
  // must_change_password가 풀리고 temp_password_expires_at이 지워져 **그 값이
  // 영구히 유효해졌다.** 이 기능이 존재하는 이유(위 TEMP_PASSWORD_HOURS 주석)가
  // 정확히 그 상태를 막는 것인데, 사용자가 가장 쉬운 길로 걸어가면 그대로 만들어졌다.
  // 그리고 사용자는 그렇게 한다 — 화면에도 서버에도 안내가 없었으므로.
  if (typeof current === "string" && next === current) {
    return res.status(400).json({
      error: "지금 쓰는 비밀번호와 다른 값으로 바꿔야 합니다. 임시 비밀번호를 그대로 다시 쓸 수 없습니다",
    });
  }
  const account = await withService(async (q) => {
    const { rows } = await q.query("select id, password_hash from auth_accounts where id = $1", [
      req.user!.accountId,
    ]);
    return rows[0];
  });
  if (!(await verify(account.password_hash, String(current ?? "")))) {
    return res.status(401).json({ error: "현재 비밀번호가 맞지 않습니다" });
  }
  const nextHash = await hash(next);
  await withService(async (q) => {
    // 임시 비밀번호를 실제로 바꿨으니 만료 시각도 지운다 — 남겨 두면 본인이 정한
    // 비밀번호가 임시 비밀번호의 만료를 물려받아 3일 뒤 로그인이 막힌다.
    await q.query(
      `update auth_accounts
          set password_hash = $2, must_change_password = false, temp_password_expires_at = null
        where id = $1`,
      [account.id, nextHash],
    );
    // 다른 기기의 세션을 끊는다(QA W-05b). 관리자 재설정 경로(reset-password)는
    // 이미 이걸 하는데 **정작 본인 경로에만 없었다** — 비밀번호가 샜다고 판단해
    // 스스로 바꾼 사람이 실제로는 침입자의 세션(최대 12시간)을 그대로 두게 된다.
    // 지금 쓰는 세션만 남긴다: 여기서 전부 끊으면 비밀번호를 바꾼 사용자가
    // 그 자리에서 튕겨 나가 다시 로그인해야 한다.
    const token = req.cookies?.[COOKIE];
    await q.query(
      "delete from auth_sessions where account_id = $1 and token_hash <> $2",
      [account.id, tokenHash(String(token ?? ""))],
    );
  });
  res.status(204).end();
});

export const adminUserRouter = Router();

adminUserRouter.patch("/:id/status", requireAuth, requireAdmin, async (req, res) => {
  const status = String(req.body?.status ?? "");
  if (status !== "active" && status !== "disabled") {
    return res.status(400).json({ error: "status는 active 또는 disabled여야 합니다" });
  }
  const targetId = String(req.params.id ?? "");
  // uuid가 아닌 값을 그대로 바인딩하면 Postgres가 22P02로 죽고 그 예외가 에러
  // 미들웨어까지 새어 500이 된다 — 클라이언트 실수와 진짜 서버 장애가 로그에서
  // 구분되지 않는다. 아래 reset-password와 같은 규칙으로 SQL에 닿기 전에 거른다.
  if (!UUID.test(targetId)) {
    return res.status(400).json({ error: "id 형식이 올바르지 않습니다" });
  }
  // 자기대상 가드. reset-password(:193 아래)에 있는 것과 같은 취지이고, 여기서는
  // 결과가 더 나쁘다: 관리자가 1명뿐인 배포(= ops/make-admin.sh가 만드는 기본 상태)에서
  // 자기 행의 "비활성화"를 누르면 서버가 status를 disabled로 바꾸고 자기 세션까지
  // 전부 지운다 → 로그인 403 → 재활성화는 admin만 할 수 있으므로 제품 안에 남는
  // 복구 경로가 없다(DB 직접 개입뿐). 남을 막는 기능이지 자기를 막는 기능이 아니다.
  if (req.user!.accountId.toLowerCase() === targetId.toLowerCase()) {
    return res.status(403).json({ error: "본인 계정의 상태는 스스로 바꿀 수 없습니다" });
  }
  const found = await withService(async (q) => {
    const { rows } = await q.query(
      // 다시 활성화할 때는 잠금도 함께 푼다(QA W-17). 예전에는 status만 바뀌어서,
      // 잠긴 계정을 관리자가 비활성화했다 활성화해도 locked_until이 그대로 남았다 —
      // 관리자는 풀어 줬다고 믿고 직원은 계속 못 들어온다. 웹에서 잠금을 푸는 다른
      // 길은 임시 비밀번호 발급뿐이라(안내서 §6-3은 서버 터미널 SQL만 알려 준다)
      // 비기술 운영자에게는 막다른 길이었다. lock_count는 지우지 않는다 —
      // 그 계정이 몇 번 잠겼는지는 관리자가 계속 볼 수 있어야 한다.
      `update auth_accounts
          set status = $2,
              failed_attempts = case when $2 = 'active' then 0 else failed_attempts end,
              locked_until = case when $2 = 'active' then null else locked_until end
        where id = $1
        returning id`,
      [targetId, status],
    );
    if (rows.length === 0) return false;
    // 퇴사자를 막는 것이 목적이다. 남아 있는 세션을 끊지 않으면 막은 의미가 없다.
    if (status === "disabled") {
      await q.query("delete from auth_sessions where account_id = $1", [targetId]);
    }
    return true;
  });
  // 없는 id에 200 {"ok":true}를 주면 관리자는 막았다고 믿는다. 같은 라우터의
  // reset-password가 이미 404를 주므로 규약도 그쪽에 맞춘다.
  if (!found) return res.status(404).json({ error: "계정을 찾을 수 없습니다" });
  res.json({ ok: true });
});

adminUserRouter.post("/:id/reset-password", requireAuth, requireAdmin, async (req, res) => {
  const targetId = String(req.params.id ?? "");
  // Postgres의 uuid 파서는 하이픈 없는 32자리, 중괄호로 감싼 표기, 대소문자
  // 섞인 표기를 전부 같은 값으로 받아들인다. 문자열 비교로 표기 변형을
  // 하나씩 쫓아가는 대신, db.ts의 withUser와 같은 정규 형식(8-4-4-4-12,
  // 대소문자 무관)이 아니면 SQL에 닿기 전에 거부한다 — 그 뒤에야 자기대상
  // 비교가 의미를 갖는다.
  if (!UUID.test(targetId)) {
    return res.status(400).json({ error: "id 형식이 올바르지 않습니다" });
  }
  // 관리자 자신을 대상으로 쓰면 현재 비밀번호 확인 없이 자기 비밀번호를 바꾸는
  // 셈이 된다 — change-password가 강제하는 "현재 비밀번호 검증"을 우회하는
  // 길이 열린다. 관리자 권한은 남을 구제하는 데만 쓰게 막는다. 위에서 이미
  // 정규 형식으로 좁혔으니, 남은 대소문자 차이만 무시하면 된다.
  if (req.user!.accountId.toLowerCase() === targetId.toLowerCase()) {
    return res.status(403).json({ error: "본인 계정은 이 방법으로 재설정할 수 없습니다" });
  }
  // 비활성 계정에는 발급하지 않는다(QA W-27). 예전에는 그대로 발급됐고, 그 값을
  // 전해 받은 사람은 로그인에서 403("사용할 수 없는 계정입니다")을 만났다 —
  // 관리자는 재설정해 줬다고 믿고 직원은 못 들어온다. 아무도 원인을 모른다.
  // 400이 아니라 409다: 요청 자체는 형식이 맞고, 계정의 **상태**가 안 맞는다.
  const target = await withService(async (q) => {
    const { rows } = await q.query("select id, status from auth_accounts where id = $1", [targetId]);
    return rows[0] ?? null;
  });
  if (!target) return res.status(404).json({ error: "계정을 찾을 수 없습니다" });
  if (target.status !== "active") {
    return res.status(409).json({
      error: "비활성화된 계정입니다. 먼저 계정을 활성화한 뒤에 임시 비밀번호를 발급하세요",
    });
  }

  const temp = temporaryPassword();
  const found = await withService(async (q) => {
    const { rows } = await q.query(
      // 만료 시각도 Postgres 시계로 찍는다(now() + interval) — 로그인 쪽 판정이
      // now()와 비교하므로 앱 시계로 만들면 두 시계가 섞인다.
      `update auth_accounts
          set password_hash = $2, must_change_password = true, failed_attempts = 0, locked_until = null,
              temp_password_expires_at = now() + ($3 || ' hours')::interval
        where id = $1
        returning id`,
      [targetId, await hash(temp), String(TEMP_PASSWORD_HOURS)],
    );
    if (rows.length === 0) return false;
    // 비밀번호를 잃어버렸다는 전제의 발급이다. 남아 있는 세션도 함께 끊는다.
    await q.query("delete from auth_sessions where account_id = $1", [targetId]);
    return true;
  });
  // 영향 행이 0이면 잘못된 id를 잘못 성공으로 오인하게 둘 수 없다.
  if (!found) return res.status(404).json({ error: "계정을 찾을 수 없습니다" });
  // 만료가 있다는 사실 자체가 관리자에게 보여야 한다 — 안 보이면 "왜 로그인이
  // 안 되죠"라는 문의로만 만료를 알게 된다. 화면이 이 시간을 그대로 안내한다.
  res.json({ temporary_password: temp, expires_in_hours: TEMP_PASSWORD_HOURS });
});
