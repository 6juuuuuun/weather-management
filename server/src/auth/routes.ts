import { Router } from "express";
import { withService } from "../db.ts";
import { hash, verify } from "./password.ts";
import { issue, lookup, revoke } from "./session.ts";
import { COOKIE, requireAuth, requireAdmin } from "./middleware.ts";

const MAX_ATTEMPTS = 5;
const LOCK_MINUTES = 15;

const allowedDomains = () =>
  (process.env.ALLOWED_EMAIL_DOMAINS ?? "").split(",").map((d) => d.trim().toLowerCase()).filter(Boolean);

export const authRouter = Router();

authRouter.post("/signup", async (req, res) => {
  const { email, password, name, department_id, phone } = req.body ?? {};
  if (!email || !password || !name) return res.status(400).json({ error: "필수 항목이 비어 있습니다" });

  const domain = String(email).split("@")[1]?.toLowerCase();
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
      // role은 갱신하지 않는다 — 이미 admin으로 올라간 기존 행이 재가입으로 staff로
      // 강등되면 안 된다. 실제 관문은 관리자의 역할 부여이지 가입이 아니다.
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
  const { email, password } = req.body ?? {};
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
        `update auth_accounts
            set failed_attempts = failed_attempts + 1,
                locked_until = case when failed_attempts + 1 >= $2
                               then now() + ($3 || ' minutes')::interval else null end
          where id = $1`,
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
