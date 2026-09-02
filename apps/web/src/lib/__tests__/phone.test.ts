import { describe, expect, it } from "vitest";
import { formatPhoneInput, PHONE_MAX_LENGTH } from "../phone";

// 이 함수가 하는 일은 **거절이 아니라 서식**이다(lib/phone.ts의 주석). 유효성 판정은
// 서버가 한다 — 두 벌로 나눠 적으면 화면만 통과시키는(또는 그 반대의) 상태가 생긴다.
describe("휴대폰 번호 입력 서식", () => {
  it("붙여넣은 여러 모양을 정규형으로 만든다", () => {
    expect(formatPhoneInput("01012345678")).toBe("010-1234-5678");
    expect(formatPhoneInput("010 1234 5678")).toBe("010-1234-5678");
    expect(formatPhoneInput("010.1234.5678")).toBe("010-1234-5678");
    expect(formatPhoneInput("010-1234-5678")).toBe("010-1234-5678");
    expect(formatPhoneInput("+82 10-1234-5678")).toBe("821-0123-4567"); // 숫자만 남는다
  });

  it("10자리는 3-3-4로 묶는다", () => {
    expect(formatPhoneInput("0111234567")).toBe("011-123-4567");
  });

  it("입력 도중에도 앞에서부터 하이픈을 넣는다", () => {
    expect(formatPhoneInput("0")).toBe("0");
    expect(formatPhoneInput("010")).toBe("010");
    expect(formatPhoneInput("0101")).toBe("010-1");
    expect(formatPhoneInput("0101234")).toBe("010-1234");
    // 8자리에서는 아직 3-3-N이고, 11자리가 되는 순간 3-4-4로 다시 묶인다.
    expect(formatPhoneInput("01012345")).toBe("010-123-45");
    expect(formatPhoneInput("01012345678")).toBe("010-1234-5678");
  });

  it("숫자가 아닌 글자는 버리고, 11자리를 넘는 숫자도 버린다", () => {
    expect(formatPhoneInput("010-abc-1234")).toBe("010-1234");
    expect(formatPhoneInput("010123456789999")).toBe("010-1234-5678");
  });

  // 지우는 동작이 막히면 안 된다 — 하이픈을 지운 결과를 다시 넣어 주면 사용자는
  // 영원히 그 자리를 못 지운다. 숫자만 보고 다시 만들므로 그런 자리가 없다.
  it("지워 나가는 도중에도 값이 되살아나지 않는다", () => {
    expect(formatPhoneInput("010-1234-567")).toBe("010-123-4567");
    expect(formatPhoneInput("010-")).toBe("010");
    expect(formatPhoneInput("")).toBe("");
  });

  it("정규형의 최대 길이는 13자다", () => {
    expect(formatPhoneInput("01012345678").length).toBe(PHONE_MAX_LENGTH);
  });
});
