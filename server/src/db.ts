import pg from "pg";

export type Querier = {
  query(text: string, params?: unknown[]): Promise<{ rows: any[] }>;
};

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// 정책을 적용받는 풀과 우회하는 풀을 분리한다. 한 풀에서 역할만 바꾸면
// 실수로 우회 상태가 남을 수 있어, 아예 다른 접속으로 갈라 둔다.
const userPool = new pg.Pool({ connectionString: process.env.DATABASE_URL_USER });
const servicePool = new pg.Pool({ connectionString: process.env.DATABASE_URL_SERVICE });

async function inTx<T>(pool: pg.Pool, setup: string | null, fn: (q: Querier) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    if (setup) await client.query(setup);
    const out = await fn(client);
    await client.query("commit");
    return out;
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}

/** 로그인한 사용자를 대신해 질의한다. 권한 정책 27개가 그대로 적용된다. */
export function withUser<T>(userId: string, fn: (q: Querier) => Promise<T>): Promise<T> {
  // 이 값은 SQL 문자열에 직접 들어가므로 형식을 먼저 막는다.
  // SET LOCAL은 파라미터 바인딩을 지원하지 않는다.
  if (!UUID.test(userId)) return Promise.reject(new Error(`사용자 ID 형식이 올바르지 않다: ${userId}`));
  // SET이 아니라 SET LOCAL이어야 한다 — 커밋과 함께 사라져 다음 요청으로 새지 않는다.
  return inTx(userPool, `set local app.current_user_id = '${userId}'`, fn);
}

/** 수집·발송처럼 특정 사용자를 대신하지 않는 서버 로직용. 정책을 우회한다. */
export function withService<T>(fn: (q: Querier) => Promise<T>): Promise<T> {
  return inTx(servicePool, null, fn);
}

// 테스트 전용. withUser는 호출마다 매번 값을 새로 SET하므로, withUser API만으로는
// "이전 커밋이 남긴 값이 이 풀에 남아 있는가"를 관찰할 수 없다 — 관찰하기 전에 이미
// 덮어써 버리기 때문이다. userPool에서 원시 커넥션을 하나 빌려 아무 SET도 하지 않고
// 곧바로 값을 읽어야만 SET LOCAL 계약이 실제로 지켜지는지 검증할 수 있다.
export async function __debugUserPoolLeftoverUserId(): Promise<string | null> {
  const client = await userPool.connect();
  try {
    const { rows } = await client.query("select current_setting('app.current_user_id', true) as v");
    return rows[0].v === "" ? null : rows[0].v;
  } finally {
    client.release();
  }
}
