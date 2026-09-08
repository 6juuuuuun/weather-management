import { describe, expect, it, vi } from "vitest";
import {
  byteLength, fitToLms, getChannel, truncationNotice, LogOnlyChannel,
  LMS_MAX_BYTES, LMS_CONTENT_BUDGET_BYTES,
} from "../../src/shared/sms.ts";
import { renderMessage, type DeptBlock } from "../../src/shared/template.ts";
import { channelName, isLogOnlyChannel } from "../../src/jobs/common.ts";

// ---------------------------------------------------------------------------
// LMS 2,000바이트 — **글자 수가 아니라 바이트**
// ---------------------------------------------------------------------------

describe("바이트로 센다", () => {
  // 이 한 줄이 이 절 전체의 이유다. 한글 666자는 글자로는 여유롭지만 바이트로는
  // 한도에 닿는다 — 글자 수로 재면 한도의 세 배를 "안전하다"고 판정한다.
  it("한글 한 글자는 3바이트다", () => {
    expect(byteLength("가")).toBe(3);
    expect(byteLength("가".repeat(666))).toBe(1998);
    expect("가".repeat(666).length).toBe(666); // 글자 수로 재면 한도의 1/3로 보인다
  });

  it("영문·숫자는 1바이트다 — 섞이면 글자 수와 바이트가 더 크게 갈라진다", () => {
    expect(byteLength("abc123")).toBe(6);
    expect(byteLength("가나다abc")).toBe(12);
  });
});

describe("fitToLms", () => {
  it("한도 안이면 손대지 않는다", () => {
    const out = fitToLms("짧은 본문");
    expect(out.truncated).toBe(false);
    expect(out.text).toBe("짧은 본문");
  });

  // 경계를 정확히 고정한다. `<=`가 `<`로 바뀌면 딱 2,000바이트인 본문이 이유 없이
  // 잘리고, 그 자리에 잘림 표시까지 붙어 오히려 내용이 사라진다.
  it("정확히 2,000바이트는 자르지 않는다", () => {
    const exact = "가".repeat(666) + "ab"; // 1998 + 2 = 2000
    expect(byteLength(exact)).toBe(LMS_MAX_BYTES);
    expect(fitToLms(exact).truncated).toBe(false);
  });

  it("2,001바이트부터 자른다", () => {
    const over = "가".repeat(666) + "abc"; // 2001
    expect(byteLength(over)).toBe(LMS_MAX_BYTES + 1);
    expect(fitToLms(over).truncated).toBe(true);
  });

  it("자른 결과는 언제나 한도 안이다", () => {
    for (const chars of [700, 1000, 5000]) {
      const out = fitToLms("가".repeat(chars));
      expect(out.truncated).toBe(true);
      expect(byteLength(out.text)).toBeLessThanOrEqual(LMS_MAX_BYTES);
    }
  });

  // **깨진 글자가 남으면 안 된다.** 바이트로 그냥 자르면 한글 한 글자의 3바이트 중
  // 2바이트만 남아 마지막에 `?`가 붙는다 — 받는 사람에게는 시스템이 고장 난 것으로
  // 보이고, 실제로 마지막 지침 한 글자가 사라진 것이다.
  it("글자 경계에서 자른다 — 깨진 문자가 남지 않는다", () => {
    const out = fitToLms("가".repeat(5000));
    // 다시 인코딩·디코딩해도 같아야 한다(깨진 바이트가 있으면 U+FFFD가 생긴다).
    expect(Buffer.from(out.text, "utf8").toString("utf8")).toBe(out.text);
    expect(out.text).not.toContain("�");
  });

  it("이모지(서로게이트 쌍)도 쪼개지 않는다", () => {
    const out = fitToLms("🚨".repeat(1000));
    expect(out.text).not.toContain("�");
    expect(Buffer.from(out.text, "utf8").toString("utf8")).toBe(out.text);
  });

  // **조용히 잘리면 안 된다.** 잘리는 것은 언제나 본문의 뒤쪽이고, 이 메시지에서
  // 뒤쪽은 마지막 지침과 고객 안내다. 받는 사람은 자기가 받은 것이 전부인 줄 안다.
  it("잘렸으면 그 사실과 전체를 볼 곳을 본문에 적는다", () => {
    const out = fitToLms("가".repeat(5000), "http://weather.local:8080");
    expect(out.truncated).toBe(true);
    expect(out.text).toContain("본문이 길어 여기까지만 전송됐습니다");
    expect(out.text).toContain("http://weather.local:8080");
  });

  it("APP_BASE_URL이 없어도 잘렸다는 사실은 반드시 남는다", () => {
    const out = fitToLms("가".repeat(5000));
    expect(out.text).toContain("본문이 길어 여기까지만 전송됐습니다");
  });

  // 표시까지 포함해 한도 안이어야 한다. 표시 몫을 빼지 않으면 표시를 붙인 순간
  // 다시 한도를 넘고, 제공자가 그 통을 거절하거나 스스로 잘라 표시마저 사라진다.
  it("잘림 표시를 붙인 뒤에도 한도 안이다", () => {
    const url = "http://weather.local:8080";
    const out = fitToLms("가".repeat(5000), url);
    expect(byteLength(out.text)).toBeLessThanOrEqual(LMS_MAX_BYTES);
    expect(byteLength(out.text)).toBeGreaterThan(LMS_MAX_BYTES - byteLength(truncationNotice(url)) - 3);
  });

  it("얼마나 넘쳤는지를 결과에 싣는다 — 얼마나 줄여야 하는지 알 수 있어야 한다", () => {
    const out = fitToLms("가".repeat(1000));
    expect(out.originalBytes).toBe(3000);
  });
});

// 지표가 발송 **전에** 넘침을 말할 수 있어야 한다(폭설이 온 뒤 확인하는 것은 늦다).
// 예비를 넉넉히 빼 두었는지 — 즉 경고가 실제 잘림보다 **먼저** 울리는지 — 를 고정한다.
// 방향이 반대가 되면(지표는 초록인데 발송에서 잘림) 이 프로젝트가 없애 온 어긋남이다.
describe("워치독이 쓰는 내용 예비(LMS_CONTENT_BUDGET_BYTES)", () => {
  it("한 통보다 작다 — 고정 부분(제목·관측 줄·잘림 표시) 몫을 빼 둔다", () => {
    expect(LMS_CONTENT_BUDGET_BYTES).toBeLessThan(LMS_MAX_BYTES);
  });

  // 예비가 실제로 충분한지를 **진짜 본문을 만들어** 확인한다. 상수를 눈으로 고른
  // 값이라 산수만으로는 보장되지 않는다.
  it("예비 안에 든 내용은 실제 본문으로 만들어도 잘리지 않는다", () => {
    // 내용을 예비 한도까지 꽉 채운다(한글 3바이트 기준).
    const filler = "가".repeat(Math.floor(LMS_CONTENT_BUDGET_BYTES / 3));
    const block: DeptBlock = {
      department_id: "d1",
      department_name: "객실운영팀아주긴부서이름입니다",
      staff_actions: [filler],
      guest_notice: "",
      recipients: [],
      selected: true,
    };
    const text = renderMessage(block, {
      kindLabel: "폭설", gradeLabel: "경보", siteName: "곤지암리조트스키장",
      obsLine: "시간당 30mm · -3℃(체감 -8) · 풍속 12m/s · 신적설 15cm(오늘 누적 40cm)",
    });
    expect(fitToLms(text, "http://weather.local:8080").truncated).toBe(false);
  });

  // 예비를 넘긴 내용은 **잘릴 수도 있다.** 여기서 요구하는 것은 "반드시 잘린다"가
  // 아니라 "지표가 먼저 운다"이므로, 한도를 크게 넘긴 경우로 방향만 고정한다.
  it("한 통을 확실히 넘기는 내용은 실제로 잘린다", () => {
    const block: DeptBlock = {
      department_id: "d1", department_name: "객실",
      staff_actions: ["가".repeat(LMS_MAX_BYTES)], guest_notice: "",
      recipients: [], selected: true,
    };
    const text = renderMessage(block, {
      kindLabel: "폭설", gradeLabel: "경보", siteName: "곤지암", obsLine: "관측",
    });
    expect(fitToLms(text).truncated).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 채널 선택 — 제공자가 들어올 자리
// ---------------------------------------------------------------------------

describe("getChannel", () => {
  it("SMS_PROVIDER가 비어 있으면 로그 전용이다 — 지금의 정상 상태다", () => {
    expect(getChannel({}).name).toBe("log");
    expect(getChannel({ SMS_PROVIDER: "" }).name).toBe("log");
    expect(getChannel({ SMS_PROVIDER: "   " }).name).toBe("log");
  });

  it("log를 명시해도 로그 전용이다", () => {
    expect(getChannel({ SMS_PROVIDER: "log" }).name).toBe("log");
  });

  // **오타가 조용히 로그로 떨어지면 안 된다.** 붙였다고 믿는데 아무것도 안 나가는
  // 상태가 이 시스템에서 가장 위험하다. 떨어뜨리되 반드시 소리를 낸다.
  it("모르는 제공자 이름이면 로그로 떨어뜨리되 소리를 낸다", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const ch = getChannel({ SMS_PROVIDER: "lsm" });
    expect(ch.name).toBe("log");
    expect(err.mock.calls.map((c) => String(c[0])).join()).toMatch(/모르는 제공자입니다/);
    err.mockRestore();
  });
});

describe("로그 전용 채널", () => {
  it("사람에게 보내지 않고 로그로 떨어뜨린다", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const r = await new LogOnlyChannel().send("010-1234-5678", "본문");
    const printed = log.mock.calls.map((c) => String(c[0])).join("\n");
    log.mockRestore();
    expect(r.ok).toBe(true);
    expect(printed).toContain("[log-channel]");
    expect(printed).toContain("본문");
  });

  // **번호를 그대로 찍지 않는다.** 이 채널이 도는 동안 docker logs에 수신자
  // 번호가 통째로 쌓이고, 로그는 장애 조사 때 복사돼 돌아다니고 백업·모니터링으로
  // 흘러간다. 어느 번호였는지 구분할 수 있으면 조사에는 충분하다.
  // 예전에는 이 테스트가 원본이 **찍히는 것**을 고정하고 있었다.
  it("수신 번호를 가려서 남긴다", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await new LogOnlyChannel().send("010-1234-5678", "본문");
    const printed = log.mock.calls.map((c) => String(c[0])).join("\n");
    log.mockRestore();
    expect(printed).toContain("010-****-5678");
    expect(printed).not.toContain("010-1234-5678");
    expect(printed).not.toContain("1234");
  });

  // 이름이 "log"인 것이 **지표의 근거**다. 이름을 바꾸면 /api/health/deep이 조용히
  // 초록이 되고, 로그로만 나가는 상태가 화면에서 사라진다(사용자 판정 2).
  it("이름이 log라서 지표가 '로그 전용'으로 판정한다", () => {
    const ch = new LogOnlyChannel();
    expect(channelName(ch)).toBe("log");
    expect(isLogOnlyChannel(ch)).toBe(true);
  });

  // 제공자가 붙는 날의 계약. 이름이 log가 아니게 되는 순간 빨간불이 풀려야 한다 —
  // 지표를 따로 고칠 필요가 없다는 것이 sms.ts 상단 주석이 약속한 내용이다.
  it("이름이 log가 아닌 채널은 로그 전용이 아니다", () => {
    const lms = { name: "lms", async send() { return { ok: true }; } };
    expect(isLogOnlyChannel(lms)).toBe(false);
    expect(channelName(lms)).toBe("lms");
  });

  // 이름 없는 채널(테스트 대역)을 실채널로 기록하면 이력이 거짓이 된다(QA W-29).
  it("이름 없는 채널은 custom으로 기록된다 — 실채널인 척하지 않는다", () => {
    expect(channelName({ async send() { return { ok: true }; } })).toBe("custom");
  });
});
