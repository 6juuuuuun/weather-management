import { describe, expect, it } from "vitest";
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
