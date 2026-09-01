import { describe, expect, it, vi } from "vitest";
import { withUser, withService, __debugUserPoolLeftoverUserId } from "../src/db.ts";

describe("권한 통로", () => {
  // SET(LOCAL 없이)을 쓰면 값이 커넥션에 남아 다음 요청이 남의 신분으로 돈다.
  // 풀에서 커넥션을 여러 번 빌려도 값이 새지 않는 것을 확인한다.
  it("트랜잭션이 끝나면 사용자 값이 남지 않는다", async () => {
    const uid = "11111111-1111-1111-1111-111111111111";
    await withUser(uid, async (q) => {
      const { rows } = await q.query("select auth.uid() as uid");
      expect(rows[0].uid).toBe(uid);
    });

    // 같은 풀에서 다시 빌렸을 때 이전 값이 보이면 안 된다
    await withService(async (q) => {
      const { rows } = await q.query("select current_setting('app.current_user_id', true) as v");
      expect(rows[0].v === null || rows[0].v === "").toBe(true);
    });
  });

  // 위 테스트는 withService(별도 풀·별도 커넥션)를 확인하므로 SET을 SET LOCAL로
  // 잘못 바꿔도 통과한다 — withUser가 매번 값을 새로 SET하기 때문에 withUser API만으로는
  // "이전 커밋이 남긴 값"을 절대 관찰할 수 없다. userPool에서 아무 SET도 없이 원시로
  // 값을 읽어야 SET LOCAL 계약을 실제로 검증할 수 있다. (SET LOCAL을 SET으로 바꾸면
  // 이 테스트는 실패해야 정상이다 — 로컬에서 직접 바꿔 실패를 확인했다.)
  it("SET LOCAL 계약: userPool을 다시 빌려도 이전 사용자 값이 남지 않는다", async () => {
    await withUser("33333333-3333-3333-3333-333333333333", async () => undefined);
    const leftover = await __debugUserPoolLeftoverUserId();
    expect(leftover).toBeNull();
  });

  it("withUser는 정책을 적용받는 역할로 접속한다", async () => {
    await withUser("11111111-1111-1111-1111-111111111111", async (q) => {
      const { rows } = await q.query("select current_user as who");
      expect(rows[0].who).toBe("app_user");
    });
  });

  it("withService는 정책을 우회하는 역할로 접속한다", async () => {
    await withService(async (q) => {
      const { rows } = await q.query("select current_user as who");
      expect(rows[0].who).toBe("app_service");
    });
  });

  it("사용자 ID가 UUID 형식이 아니면 거부한다", async () => {
    await expect(
      withUser("'; drop table employees; --", async () => undefined),
    ).rejects.toThrow(/사용자 ID/);
  });
});

// Postgres가 재시작하면(운영 중 흔한 일이다 — 컨테이너 재기동, 백업 후 복구)
// 그 시점에 풀에서 놀고 있던 커넥션이 전부 서버 쪽에서 끊긴다. pg.Pool은 그때
// 'error'를 emit하는데, 리스너가 하나도 없으면 EventEmitter가 그것을 예외로
// 다시 던져 Node 프로세스가 통째로 죽는다.
//
// 이 테스트는 그 상황을 실제로 만든다: 커넥션을 하나 만들어 유휴 상태로 풀에
// 남긴 뒤, 다른 커넥션에서 그 백엔드를 강제 종료한다. 리스너를 지우면
// uncaughtException이 나면서 이 파일이 통째로 실패한다(변이 확인함).
describe("유휴 커넥션이 서버 쪽에서 끊길 때", () => {
  it("프로세스를 죽이지 않고 로그만 남긴다", async () => {
    // 풀에 유휴 커넥션을 여러 개 만들어 둔다. 동시에 빌려야 풀이 커넥션을
    // 실제로 여러 개 연다 — 순차로 부르면 같은 커넥션 하나를 재사용해서
    // "놀고 있는 커넥션"이 생기지 않는다.
    await Promise.all([
      withService((q) => q.query("select pg_sleep(0.1)")),
      withService((q) => q.query("select pg_sleep(0.1)")),
      withService((q) => q.query("select pg_sleep(0.1)")),
    ]);

    const logged: unknown[][] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      logged.push(args);
    });
    try {
      // 지금 이 질의가 쓰는 커넥션만 빼고, 같은 역할의 놀고 있는 백엔드를 끊는다.
      // (다른 역할의 백엔드는 권한상 끊을 수 없으므로 대상에 넣지 않는다.)
      const killed = await withService(async (q) => {
        const { rows } = await q.query(
          `select pg_terminate_backend(pid) from pg_stat_activity
            where usename = current_user and pid <> pg_backend_pid()`,
        );
        return rows.length;
      });
      expect(killed).toBeGreaterThan(0);

      // 끊김이 풀까지 전달될 시간을 준다.
      await new Promise((r) => setTimeout(r, 500));
      const text = logged.map((a) => a.map(String).join(" ")).join("\n");
      expect(text).toMatch(/유휴 커넥션 오류/);
    } finally {
      spy.mockRestore();
    }

    // 끊긴 뒤에도 다음 질의는 새 커넥션으로 정상 처리돼야 한다.
    const { rows } = await withService((q) => q.query("select 1 as n"));
    expect(rows[0].n).toBe(1);
  });
});
