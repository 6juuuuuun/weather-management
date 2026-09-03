import { describe, expect, it, afterAll } from "vitest";
import { withService } from "../src/db.ts";
import { isSendablePhone, sendablePhoneSql, normalizePhone } from "../src/phone.ts";

// "이 사람에게 특보를 보낼 수 있는가"를 무엇으로 셀지가 갈라지면 어떤 일이 벌어지는지
// 이 프로젝트는 이미 네 번 겪었다. 카카오워크 시절 그 답은 `kakaowork_user_id is not
// null`이었고, SMS로 바뀌면서 `employees.phone`으로 옮겨 왔다.
//
// **여기서 새로 생긴 위험:** 카카오워크 user id는 조회로만 채워져 형식이 언제나
// 일정했지만, `phone`에는 **형식 검증(phone.ts)이 생기기 전에 저장된 값**이 남아 있을
// 수 있다. 그래서 "값이 있다"와 "보낼 수 있다"가 처음으로 갈라진다. 세는 쪽이 앞을
// 쓰고 보내는 쪽이 뒤를 쓰면, 지표는 "N명에게 보낼 수 있다"인데 실제 발송은 0명이다 —
// 그것이 정확히 QA가 네 번 찾아낸 결함의 모양이다.
//
// 규칙은 phone.ts 한 곳에 있지만 여전히 JS와 SQL 두 벌로 적힌다(질의 안에서 JS를 부를
// 수 없다). SQL 쪽은 같은 정규식의 `source`에서 뽑아 쓰므로 갈라질 자리가 없어야
// 하는데, **"없어야 한다"는 주석일 뿐이다.** 그래서 실제 Postgres에 물어본다.
// guideline-content.test.ts와 같은 처방이다.

const EMAIL = "zzphone-sendable@gonjiam.com";

const CASES: { label: string; stored: string | null; expected: boolean }[] = [
  // 정규형 — 쓰기 경로가 저장하는 모양이다.
  { label: "010 정규형", stored: "010-1234-5678", expected: true },
  { label: "011 10자리 정규형", stored: "011-234-5678", expected: true },
  { label: "016 11자리 정규형", stored: "016-1234-5678", expected: true },

  // 형식 검증 이전에 들어왔을 수 있는 값들 — **전부 보낼 수 없다.**
  { label: "값 없음", stored: null, expected: false },
  { label: "빈 문자열", stored: "", expected: false },
  { label: "공백만", stored: "   ", expected: false },
  { label: "유선 번호", stored: "02-123-4567", expected: false },
  { label: "내선이 붙은 유선", stored: "02) 123-4567 (내선 8)", expected: false },
  { label: "자릿수 모자란 010", stored: "010-1234-567", expected: false },
  { label: "자릿수 넘는 010", stored: "010-1234-56789", expected: false },
  { label: "없는 번호대(012)", stored: "012-1234-5678", expected: false },
  { label: "글자가 섞인 값", stored: "abc010def12345678", expected: false },
  { label: "국가번호 표기", stored: "+82-10-1234-5678", expected: false },

  // 구분자 변형 — 붙여넣기로 들어올 수 있는 모양들. 저장은 정규형으로 되지만
  // 옛 값에는 이 모양이 그대로 남아 있을 수 있고, 그때도 발송은 가능해야 한다.
  { label: "하이픈 없는 11자리", stored: "01012345678", expected: true },
  { label: "공백 구분", stored: "010 1234 5678", expected: true },
  { label: "점 구분", stored: "010.1234.5678", expected: true },
];

afterAll(async () => {
  await withService((q) => q.query("delete from employees where email = $1", [EMAIL]));
});

describe("isSendablePhone(JS)와 sendablePhoneSql(SQL)이 같은 판정을 낸다", () => {
  it.each(CASES.map((c) => [c.label, c] as const))("%s", async (_label, c) => {
    const sqlSaysSendable = await withService(async (q) => {
      await q.query("delete from employees where email = $1", [EMAIL]);
      await q.query("insert into employees (name, email, phone) values ('번호검사', $1, $2)", [
        EMAIL,
        c.stored,
      ]);
      const { rows } = await q.query(
        `select count(*)::int as n from employees e
          where e.email = $1 and ${sendablePhoneSql("e.phone")}`,
        [EMAIL],
      );
      return Number(rows[0].n) > 0;
    });

    const jsSaysSendable = isSendablePhone(c.stored);

    // 기대값을 못박는다. 두 판정이 **함께** 틀리면 서로 같기만 해서는 잡히지 않는다.
    expect(jsSaysSendable).toBe(c.expected);
    expect(sqlSaysSendable).toBe(c.expected);
  });
});

// 쓰기 경로가 통과시킨 값은 반드시 보낼 수 있어야 한다. 이 둘이 어긋나면 관리자가
// 정상으로 저장한 번호가 발송 대상에서 조용히 빠진다 — 화면에는 번호가 보이므로
// 아무도 그 사실을 모른다.
describe("저장이 허용한 번호는 언제나 보낼 수 있다", () => {
  it.each([
    "010-1234-5678",
    "01012345678",
    "010 1234 5678",
    "010.1234.5678",
    "011-234-5678",
    "0111234567",
    "019-1234-5678",
  ])("%s", (raw) => {
    const normalized = normalizePhone(raw);
    expect(normalized.ok).toBe(true);
    // 정규형으로 저장되고, 그 정규형이 다시 발송 가능이어야 한다.
    expect(isSendablePhone((normalized as { phone: string }).phone)).toBe(true);
  });

  // 반대쪽: 저장이 거절한 값은 발송 대상도 아니다. 이 방향이 깨지면 "거절당했는데
  // 지표에는 잡히는" 유령이 생긴다.
  it.each(["02-123-4567", "010-1234-567", "012-1234-5678", "abc"])("거절: %s", (raw) => {
    expect(normalizePhone(raw).ok).toBe(false);
    expect(isSendablePhone(raw)).toBe(false);
  });
});
