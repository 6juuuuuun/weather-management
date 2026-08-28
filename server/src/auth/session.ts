import { createHash, randomBytes } from "node:crypto";
import { withService } from "../db.ts";

const TTL_HOURS = 12;

const hashToken = (t: string) => createHash("sha256").update(t).digest("hex");

/** 원문 토큰을 돌려주고 DB에는 해시만 남긴다. */
export async function issue(accountId: string): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  await withService((q) =>
    q.query(
      `insert into auth_sessions (token_hash, account_id, expires_at)
       values ($1, $2, now() + ($3 || ' hours')::interval)`,
      [hashToken(token), accountId, String(TTL_HOURS)],
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
};

export async function lookup(token: string): Promise<SessionUser | null> {
  return withService(async (q) => {
    const { rows } = await q.query(
      `select a.id, a.email, a.must_change_password, e.id as employee_id, e.role
         from auth_sessions s
         join auth_accounts a on a.id = s.account_id
         left join employees e on e.auth_user_id = a.id
        where s.token_hash = $1 and s.expires_at > now() and a.status = 'active'`,
      [hashToken(token)],
    );
    if (rows.length === 0) return null;
    return {
      accountId: rows[0].id,
      employeeId: rows[0].employee_id ?? null,
      role: rows[0].role ?? null,
      email: rows[0].email,
      mustChangePassword: rows[0].must_change_password,
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
