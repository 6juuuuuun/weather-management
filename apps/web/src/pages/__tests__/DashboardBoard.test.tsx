import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { DashboardBoard, statusHeadline } from "../DashboardBoard";
import type { BoardEvent, BoardMetric } from "../DashboardBoard";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const metrics: BoardMetric[] = [
  { key: "rain", label: "시간당 강수량", unit: "mm", value: 0, threshold: 20,
    gradeLabel: "폭우 주의보", allowNegative: false, history: [0, 0, 0] },
  { key: "temp", label: "기온", unit: "℃", value: 28.9, threshold: 33,
    gradeLabel: "폭염 주의보", allowNegative: true, history: [27, 28, 28.9] },
  { key: "wind", label: "풍속", unit: "m/s", value: 2.5, threshold: 14,
    gradeLabel: "강풍 주의보", allowNegative: false, history: [1, 2, 2.5] },
  { key: "feels", label: "체감온도", unit: "℃", value: 29.8, threshold: 31,
    gradeLabel: "폭염 주의보", allowNegative: true, history: [28, 29, 29.8] },
];

const pending: BoardEvent = {
  id: "e1", title: "폭우 경보", tag: "승인 대기",
  detail: "13:05 감지 · 초안 5개 부서 · 재알림 2회", severe: true,
};
const sent: BoardEvent = {
  id: "e2", title: "폭염 경보", tag: "발송 완료",
  detail: "11:05 승인 · 5개 부서 12명 · 반복 3회차", severe: true,
};

function renderBoard(events: BoardEvent[] = []) {
  return render(
    <DashboardBoard siteName="곤지암" clock="13:47" collectedAgo="마지막 수집 2분 전"
                    stale={false} loadError={null} metrics={metrics} events={events} />,
  );
}

describe("statusHeadline", () => {
  it("열린 특보가 없으면 평온", () => {
    expect(statusHeadline([])).toEqual({ text: "평온", alert: false });
  });

  it("승인 대기가 있으면 특보 발생", () => {
    expect(statusHeadline([pending])).toEqual({ text: "특보 발생", alert: true });
  });

  it("전부 발송 완료면 대응 중", () => {
    expect(statusHeadline([sent])).toEqual({ text: "대응 중", alert: true });
  });

  it("승인 대기가 하나라도 있으면 특보 발생이 우선", () => {
    expect(statusHeadline([sent, pending]).text).toBe("특보 발생");
  });
});

// QA W-14 · 조용히 멈춘 화면과 정상 화면이 벽에서 구분되지 않았다.
describe("statusHeadline 낡음·실패", () => {
  it("조회에 실패하면 특보보다 먼저 그 사실을 말한다", () => {
    expect(statusHeadline([], { failed: true })).toEqual({ text: "연결 끊김", alert: true });
    // 열린 특보가 있어도 실패가 우선이다 — 그 특보 목록 자체가 낡은 값이다.
    expect(statusHeadline([pending], { failed: true }).text).toBe("연결 끊김");
  });

  it("관측이 낡았으면 평온이라고 말하지 않는다", () => {
    expect(statusHeadline([], { stale: true })).toEqual({ text: "수집 중단", alert: true });
  });

  it("멀쩡하면 예전 그대로다", () => {
    expect(statusHeadline([], { stale: false, failed: false })).toEqual({ text: "평온", alert: false });
  });
});

describe("DashboardBoard 낡음·실패 표시", () => {
  function renderState(stale: boolean, loadError: string | null, collectedAgo = "02:00 관측 기준 · 3일 전") {
    return render(
      <DashboardBoard siteName="곤지암" clock="13:47" collectedAgo={collectedAgo}
        stale={stale} loadError={loadError} metrics={metrics} events={[]} />,
    );
  }

  it("정상일 때는 띠를 그리지 않는다", () => {
    const { container } = render(
      <DashboardBoard siteName="곤지암" clock="13:47" collectedAgo="14:00 관측 기준"
        stale={false} loadError={null} metrics={metrics} events={[]} />,
    );
    expect(container.querySelector(".bd-alarm")).toBeNull();
    expect(container.querySelector(".bd-collected-stale")).toBeNull();
  });

  it("관측이 낡으면 띠와 함께 언제 관측이었는지를 눈에 띄게 적는다", () => {
    const { container } = renderState(true, null);
    // 상단 한 마디와 띠 제목 둘 다 "수집 중단"이다 — 벽에서 읽히는 자리 두 곳.
    expect(container.querySelector(".bd-status")!.textContent).toBe("수집 중단");
    expect(container.querySelector(".bd-alarm-title")!.textContent).toBe("수집 중단");
    // 수집 시각 자체도 회색이 아니라 경고 색으로 바뀐다.
    expect(container.querySelector(".bd-collected-stale")).toBeTruthy();
    expect(container.querySelector(".bd-alarm")!.textContent).toMatch(/3일 전/);
  });

  it("조회에 실패하면 서버 연결 끊김을 알린다", () => {
    const { container } = renderState(false, "서버에 연결할 수 없습니다");
    expect(container.querySelector(".bd-alarm")!.textContent).toMatch(/서버 연결 끊김/);
    expect(container.querySelector(".bd-status")!.textContent).toBe("연결 끊김");
  });

  it("띠는 특보 배너보다 위에 온다", () => {
    const { container } = render(
      <DashboardBoard siteName="곤지암" clock="13:47" collectedAgo="02:00 관측 기준 · 3일 전"
        stale={true} loadError={null} metrics={metrics} events={[pending]} />,
    );
    const alarm = container.querySelector(".bd-alarm")!;
    const events = container.querySelector(".bd-events")!;
    // 값이 낡았다는 사실을 알기 전에 숫자를 먼저 읽게 해서는 안 된다.
    expect(alarm.compareDocumentPosition(events) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe("DashboardBoard", () => {
  it("사업장·시각·수집 시각을 표시한다", () => {
    const { getByText } = renderBoard();
    expect(getByText("곤지암")).toBeTruthy();
    expect(getByText("13:47")).toBeTruthy();
    expect(getByText("마지막 수집 2분 전")).toBeTruthy();
  });

  it("지표 카드 4장을 렌더링한다", () => {
    const { container } = renderBoard();
    expect(container.querySelectorAll(".bd-card").length).toBe(4);
  });

  it("특보가 없으면 배너를 렌더링하지 않는다", () => {
    const { container } = renderBoard();
    expect(container.querySelector(".bd-events")).toBeNull();
  });

  it("특보가 1건이면 세로 배치", () => {
    const { container } = renderBoard([pending]);
    expect(container.querySelector(".bd-events")?.className).not.toContain("bd-events-row");
  });

  // 세로로 쌓으면 카드가 짧아져 차트가 잘린다(시안에서 실측).
  it("특보가 2건 이상이면 가로 배치", () => {
    const { container } = renderBoard([pending, sent]);
    expect(container.querySelector(".bd-events")?.className).toContain("bd-events-row");
  });

  it("특보가 4건 이상이면 3건만 보이고 나머지는 접는다", () => {
    const many = [1, 2, 3, 4, 5].map((n) => ({ ...pending, id: `e${n}`, title: `특보${n}` }));
    const { container, getByText } = renderBoard(many);
    expect(container.querySelectorAll(".bd-event").length).toBe(3);
    expect(getByText("외 2건")).toBeTruthy();
  });

  it("값이 없는 지표는 대시 기호를 보여준다", () => {
    const { getByText } = render(
      <DashboardBoard siteName="곤지암" clock="13:47" collectedAgo="—"
        stale={false} loadError={null} metrics={[{ ...metrics[0], value: null, history: [] }]} events={[]} />,
    );
    expect(getByText("–")).toBeTruthy();
  });

  it("조작 요소를 렌더링하지 않는다", () => {
    const { container } = renderBoard([pending]);
    expect(container.querySelector("button")).toBeNull();
    expect(container.querySelector("a")).toBeNull();
  });

  // F1: threshold<=0은 "기준 미설정"이다. 값이 있어도 티커·차트·카드 색
  // 세 곳 모두에서 거짓 경보(가짜 기준선, "…초과" 문구, 빨간 숫자)를 내면 안 된다.
  it("threshold가 0인 지표는 티커에 나타나지 않고 기준선도 그리지 않으며 카드가 빨갛지 않다", () => {
    const zeroThresholdMetric: BoardMetric = {
      key: "rain", label: "시간당 강수량", unit: "mm", value: 5, threshold: 0,
      // history는 임계 0이 computeScale의 사정권(데이터 폭의 0.7배) 안에 들어오는
      // 값이어야 한다. [3,4,5]처럼 0에서 먼 값이면 기준선이 어차피 안 그려져
      // 가드가 우연히 통과한다 — 결함을 되살려도 초록이 되는 픽스처는 가드가 아니다.
      // [0.2,1.0,0.5] → computeScale(..., 0, false) = {lo:0, hi:1.15, thresholdVisible:true}.
      gradeLabel: "폭우 주의보", allowNegative: false, history: [0.2, 1.0, 0.5],
    };
    const { container } = render(
      <DashboardBoard siteName="곤지암" clock="13:47" collectedAgo="마지막 수집 2분 전"
        stale={false} loadError={null} metrics={[zeroThresholdMetric]} events={[]} />,
    );
    // 티커: threshold<=0 지표를 빼면 항목이 하나도 없어 트랙 자체가 렌더되지 않는다.
    expect(container.querySelector(".bt")).toBeNull();
    // 차트: 기준선을 그리지 않는다.
    expect(container.querySelector("line.mc-threshold")).toBeNull();
    // 카드: 값이 임계(0) 이상이어도 danger 색 클래스가 붙지 않는다.
    expect(container.querySelector(".bd-value-over")).toBeNull();
  });
});

// `?raw`는 못 쓴다 — vitest는 CSS 모듈을 빈 문자열로 스텁해서 `?raw`도 ""가 된다.
// `new URL(..., import.meta.url)`도 못 쓴다 — vite가 정적 에셋 URL로 바꿔버린다.
// 주석은 걷어낸다(규칙 경계를 `}`로 잡으므로 주석이 끼면 어긋난다).
const css = readFileSync(join(import.meta.dirname, "../DashboardBoard.css"), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "");

/** 선택자 하나의 선언 블록만 떼어낸다. 앞을 `}`로 묶어 `.bd-events-row .bd-event`
 *  같은 하위 오버라이드가 기본 규칙으로 잘못 잡히지 않게 한다. */
function ruleOf(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = new RegExp(`(?:^|\\})\\s*${escaped}\\s*\\{([^}]*)\\}`).exec(css);
  if (!m) throw new Error(`${selector} 규칙이 없다`);
  return m[1];
}

// jsdom은 레이아웃을 계산하지 않아 "차트가 카드를 넘쳤다"를 렌더로 잡을 수 없다.
// 그래서 넘침을 막는 CSS 계약 자체를 원문으로 고정한다.
describe("DashboardBoard.css 레이아웃 계약", () => {
  // height:auto(MetricChart.css의 종횡비 유래 기본값)는 카드 높이와 무관해서,
  // 특보 배너가 카드 영역을 줄이면 차트가 카드 밖으로 넘치고 overflow:hidden이
  // 하단을 잘라낸다. 뷰포트에 같이 줄어드는 vh여야 어떤 창 크기에서도 안전하다.
  it(".bd-card .mc의 height가 vh 단위다", () => {
    // 앞을 `^|;`로 묶는다 — 앵커가 없으면 `line-height`·`min-height`의 뒷부분에
    // 물려서, height:auto가 살아 있어도 초록이 되거나 멀쩡한데 빨개진다.
    const height = /(?:^|;)\s*height:\s*([^;]+);/.exec(ruleOf(".bd-card .mc"))?.[1].trim();
    expect(height).toBeTruthy();
    expect(height).not.toBe("auto");
    expect(height).toMatch(/vh$/);
  });

  // 배너 세로 크기가 px로 고정되면 뷰포트가 낮아져도 줄지 않아, 특보 1건이
  // 3건보다 더 높은 최악 케이스가 된다(1512×650에서 −3.5px로 차트가 잘렸다).
  // 세로에 관여하는 값만 vh다 — 좌우 padding·column-gap은 px 그대로가 맞다.
  it("배너 기본(세로 배치) 규칙의 세로 값이 vh 단위다", () => {
    const event = ruleOf(".bd-event");
    expect(event).toMatch(/padding:\s*[\d.]+vh/);
    expect(event).toMatch(/row-gap:\s*[\d.]+vh/);
    // shorthand gap이 남아 있으면 row-gap을 덮어써 세로만 vh로 만든 의도가 깨진다.
    expect(event).not.toMatch(/[^-]gap:\s*\d/);
    for (const sel of [".bd-event-title", ".bd-event-detail", ".bd-more"]) {
      expect(ruleOf(sel)).toMatch(/font-size:\s*[\d.]+vh/);
    }
  });
});
