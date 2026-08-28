import { Router } from "express";
import { withService } from "../db.ts";
import { hash, verify, temporaryPassword } from "./password.ts";
import { issue, lookup, revoke } from "./session.ts";
import { COOKIE, requireAuth, requireAdmin } from "./middleware.ts";

const MAX_ATTEMPTS = 5;
const LOCK_MINUTES = 15;
const MIN_PASSWORD = 10;

const allowedDomains = () =>
  (process.env.ALLOWED_EMAIL_DOMAINS ?? "").split(",").map((d) => d.trim().toLowerCase()).filter(Boolean);

export const authRouter = Router();

authRouter.post("/signup", async (req, res) => {
  const { password, name, department_id, phone } = req.body ?? {};
  const emailRaw = req.body?.email;
  if (!emailRaw || !password || !name) return res.status(400).json({ error: "필수 항목이 비어 있습니다" });

  // 이메일 대소문자를 정규화한다. 그대로 두면 Kim@과 kim@이 서로 다른 계정·직원
  // 행으로 갈라져 같은 사람이 명부에 두 번 오르고, 부서 수신자 목록에도 중복으로
  // 들어가 특보가 두 번 나가는 등 발송 대상이 어긋난다.
  const email = String(emailRaw).trim().toLowerCase();

  const domain = email.split("@")[1];
  if (!domain || !allowedDomains().includes(domain)) {
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
      await q.query(
        `insert into employees (auth_user_id, name, email, phone, department_id, role)
         values ($1, $2, $3, $4, $5, 'staff')
         on conflict (email) do update
           set auth_user_id = excluded.auth_user_id,
               name = excluded.name,
               phone = coalesce(excluded.phone, employees.phone),
               department_id = coalesce(excluded.department_id, employees.department_id)`,
        [rows[0].id, name, email, phone ?? null, department_id ?? null],
      );
    });
  } catch (e: any) {
    if (e?.code === "23505") return res.status(409).json({ error: "이미 가입된 이메일입니다" });
    throw e;
  }
  res.status(201).json({ ok: true });
});

authRouter.post("/login", async (req, res) => {
  const { password } = req.body ?? {};
  const email = String(req.body?.email ?? "").trim().toLowerCase();
  const account = await withService(async (q) => {
    const { rows } = await q.query(
      "select id, password_hash, status, failed_attempts, locked_until, must_change_password from auth_accounts where email = $1",
      [email],
    );
    return rows[0] ?? null;
  });

  // 계정이 없을 때와 비밀번호가 틀렸을 때의 응답을 같게 유지한다.
  // 다르면 어떤 이메일이 가입돼 있는지 캐낼 수 있다.
  const deny = () => res.status(401).json({ error: "로그인할 수 없습니다" });
  if (!account) return deny();

  if (account.locked_until && new Date(account.locked_until) > new Date()) {
    return res.status(423).json({ error: "잠시 후 다시 시도해 주세요" });
  }

  if (!(await verify(account.password_hash, String(password ?? "")))) {
    await withService((q) =>
      q.query(
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
                               then now() + ($3 || ' minutes')::interval else null end
           from (
             select id,
                    case when locked_until is not null and locked_until <= now()
                         then 1
                         else failed_attempts + 1
                    end as next_failed
               from auth_accounts
              where id = $1
           ) t
          where a.id = t.id`,
        [account.id, MAX_ATTEMPTS, String(LOCK_MINUTES)],
      ),
    );
    return deny();
  }

  if (account.status !== "active") {
    return res.status(403).json({ error: "사용할 수 없는 계정입니다. 관리자에게 문의해 주세요" });
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
  const account = await withService(async (q) => {
    const { rows } = await q.query("select id, password_hash from auth_accounts where id = $1", [
      req.user!.accountId,
    ]);
    return rows[0];
  });
  if (!(await verify(account.password_hash, String(current ?? "")))) {
    return res.status(401).json({ error: "현재 비밀번호가 맞지 않습니다" });
  }
  await withService(async (q) =>
    q.query("update auth_accounts set password_hash = $2, must_change_password = false where id = $1", [
      account.id,
      await hash(next),
    ]),
  );
  res.status(204).end();
});

export const adminUserRouter = Router();

adminUserRouter.patch("/:id/status", requireAuth, requireAdmin, async (req, res) => {
  const status = String(req.body?.status ?? "");
  if (status !== "active" && status !== "disabled") {
    return res.status(400).json({ error: "status는 active 또는 disabled여야 합니다" });
  }
  await withService(async (q) => {
    await q.query("update auth_accounts set status = $2 where id = $1", [req.params.id, status]);
    // 퇴사자를 막는 것이 목적이다. 남아 있는 세션을 끊지 않으면 막은 의미가 없다.
    if (status === "disabled") {
      await q.query("delete from auth_sessions where account_id = $1", [req.params.id]);
    }
  });
  res.json({ ok: true });
});

adminUserRouter.post("/:id/reset-password", requireAuth, requireAdmin, async (req, res) => {
  const targetId = String(req.params.id ?? "");
  // 관리자 자신을 대상으로 쓰면 현재 비밀번호 확인 없이 자기 비밀번호를 바꾸는
  // 셈이 된다 — change-password가 강제하는 "현재 비밀번호 검증"을 우회하는
  // 길이 열린다. 관리자 권한은 남을 구제하는 데만 쓰게 막는다.
  // uuid 컬럼은 Postgres에서 값으로(대소문자 무시) 비교되지만 JS의 ===는
  // 대소문자를 구분한다. 그대로 두면 관리자가 자기 accountId를 대문자로 바꿔
  // 보내는 것만으로 이 가드를 피해 가고, SQL은 정확히 자기 행을 찾아 갱신해
  // 버린다 — 두 비교 기준을 반드시 맞춘다.
  if (req.user!.accountId.toLowerCase() === targetId.toLowerCase()) {
    return res.status(403).json({ error: "본인 계정은 이 방법으로 재설정할 수 없습니다" });
  }
  const temp = temporaryPassword();
  const found = await withService(async (q) => {
    const { rows } = await q.query(
      "update auth_accounts set password_hash = $2, must_change_password = true, failed_attempts = 0, locked_until = null where id = $1 returning id",
      [targetId, await hash(temp)],
    );
    if (rows.length === 0) return false;
    // 비밀번호를 잃어버렸다는 전제의 발급이다. 남아 있는 세션도 함께 끊는다.
    await q.query("delete from auth_sessions where account_id = $1", [targetId]);
    return true;
  });
  // 영향 행이 0이면 잘못된 id를 잘못 성공으로 오인하게 둘 수 없다.
  if (!found) return res.status(404).json({ error: "계정을 찾을 수 없습니다" });
  res.json({ temporary_password: temp });
});
