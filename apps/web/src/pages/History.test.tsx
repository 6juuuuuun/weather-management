import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { DeptBlock } from "../lib/types";

const detected_at = "2026-07-16T08:00:00.000Z";
const sent_at = "2026-07-16T08:10:00.000Z";

const content: DeptBlock[] = [
  {
    department_id: "d1",
    department_name: "리조트",
    staff_actions: ["수건 추가 배포"],
    guest_notice: "야외 시설 운영이 제한됩니다",
    recipients: [{ employee_id: "e1", name: "홍수진", kakaowork_user_id: "k1" }],
    selected: true,
  },
];

const dispatchRow = {
  id: 12,
  message_id: "m1",
  event_id: "ev1",
  sent_at,
  channel: "kakaowork",
  repeat_no: 3,
  is_test: false,
  results: [{ employee_id: "e1", name: "홍수진", ok: true }],
  messages: { content },
  weather_events: { kind: "rain", grade: "watch", detected_at },
};

vi.mock("../auth/AuthProvider", () => ({
  useAuth: () => ({
    employee: { id: "emp1", name: "김운영", role: "approver" },
    loading: false,
    signOut: () => {},
  }),
}));

vi.mock("../lib/supabase", () => ({
  supabase: {
    from: () => ({
      select: () => ({
        eq: () => ({
          single: () => Promise.resolve({ data: null, error: null }),
          order: () => ({
            limit: () => Promise.resolve({ data: [dispatchRow], error: null }),
          }),
        }),
      }),
    }),
  },
}));

vi.mock("../lib/api", () => ({
  callSend: vi.fn(),
}));

import History from "./History";

describe("History", () => {
  it("발송 이력 목록을 렌더링한다", async () => {
    render(
      <MemoryRouter>
        <History />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByText("폭우")).toBeInTheDocument());
    expect(screen.getByText("주의보")).toBeInTheDocument();
    expect(screen.getByText("리조트 · 1명")).toBeInTheDocument();
    expect(screen.getByText("성공 1")).toBeInTheDocument();
    expect(screen.getByText("3회차")).toBeInTheDocument();
    expect(screen.getByText("재발송")).toBeInTheDocument();
  });

  it("행 클릭 시 모달에 발송 당시 내용이 표시된다", async () => {
    render(
      <MemoryRouter>
        <History />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByText("폭우")).toBeInTheDocument());
    screen.getByText("리조트 · 1명").closest("tr")?.click();
    expect(await screen.findByText("수건 추가 배포")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "수정 후 재발송" })).toBeInTheDocument();
  });
});
