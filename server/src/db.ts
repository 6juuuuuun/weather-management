import pg from "pg";

export type Querier = {
  query(text: string, params?: unknown[]): Promise<{ rows: any[] }>;
};

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// pg는 numeric 컬럼을 정밀도 손실을 피하려고 기본적으로 문자열로 돌려준다(예: "21.5").
// weather_observations의 관측값들(temp_c 등)이 전부 numeric이라 이걸 그대로 두면
// API 응답의 숫자 필드가 죄다 문자열이 되어, 화면 쪽 산술·비교가 조용히 깨진다.
// pg.types는 프로세스 전역 레지스트리라 여기서 한 번만 등록하면 두 풀(아래) 모두에 적용된다.
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (v) => parseFloat(v));

// 정책을 적용받는 풀과 우회하는 풀을 분리한다. 한 풀에서 역할만 바꾸면
// 실수로 우회 상태가 남을 수 있어, 아예 다른 접속으로 갈라 둔다.
const userPool = new pg.Pool({ connectionString: process.env.DATABASE_URL_USER });
const servicePool = new pg.Pool({ connectionString: process.env.DATABASE_URL_SERVICE });

// pg.Pool은 "빌려 쓰지 않고 놀고 있는" 커넥션이 서버 쪽에서 끊기면 error를
// 던진다(Postgres 재시작, 관리자의 pg_terminate_backend, 네트워크 단절).
// EventEmitter는 리스너가 하나도 없는 'error'를 예외로 다시 던지므로, 리스너가
// 없으면 그 순간 Node 프로세스가 통째로 죽는다 — Postgres 컨테이너를 한 번
// 재시작한 것만으로 앱이 내려간다는 뜻이다. compose의 restart: unless-stopped가
// 다시 띄워 주긴 하지만, 무인 운영 시스템이 그 복구에 기대면 안 된다.
// 로그만 남기고 흘려보낸다: 끊긴 커넥션은 pg가 알아서 풀에서 버리고, 다음
// 요청은 새 커넥션으로 정상 처리된다.
// 에러 객체를 통째로 찍지 않고 한 줄로 줄인다: pg의 에러는 스택과 내부 Client
// 필드까지 달고 있어 끊김 한 번에 로그가 90줄쯤 늘어난다. 운영 안내서는
// "로그 마지막 몇 줄에 답이 있다"고 알려 주는데, 그 몇 줄이 이 덤프로 밀려
// 사라지면 안 된다. 이 부류의 오류는 message 한 줄이 사실상 전부다
// (예: "terminating connection due to administrator command").
for (const [name, pool] of [["user", userPool], ["service", servicePool]] as const) {
  pool.on("error", (err: Error) => console.error(`[db] ${name} 풀의 유휴 커넥션 오류: ${err.message}`));
}

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
