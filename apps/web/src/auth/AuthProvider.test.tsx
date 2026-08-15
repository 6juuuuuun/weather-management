import { describe, expect, it, vi } from "vitest";
import { act, render, waitFor } from "@testing-library/react";
import type { Employee } from "../lib/types";

// employees/alert_recipients 조회 순서·타이밍을 테스트가 직접 통제하기 위해
// resolve를 나중에 호출할 수 있는 deferred promise를 큐에 담아 소비시킨다.
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const empA: Employee = {
  id: "emp-a",
  auth_user_id: "u-a",
  name: "A",
  email: "a@example.com",
  kakaowork_user_id: null,
  department_id: null,
  role: "approver",
  created_at: "2026-01-01T00:00:00Z",
};

const empB: Employee = {
  id: "emp-b",
  auth_user_id: "u-b",
  name: "B",
  email: "b@example.com",
  kakaowork_user_id: null,
  department_id: null,
  role: "approver",
  created_at: "2026-01-01T00:00:00Z",
};

const mocks = vi.hoisted(() => ({
  authChangeCb: null as null | (() => void),
  userQueue: [] as Promise<{ data: { user: { id: string } | null } }>[],
  empQueue: [] as Promise<{ data: Employee | null }>[],
  recipQueue: [] as Promise<{ data: unknown }>[],
}));

vi.mock("../lib/supabase", () => ({
  supabase: {
    auth: {
      getUser: () => mocks.userQueue.shift(),
      onAuthStateChange: (cb: () => void) => {
        mocks.authChangeCb = cb;
        return { data: { subscription: { unsubscribe: () => {} } } };
      },
      signOut: () => Promise.resolve(),
    },
    from: (table: string) => {
      if (table === "employees") {
        return { select: () => ({ eq: () => ({ single: () => mocks.empQueue.shift() }) }) };
      }
      if (table === "alert_recipients") {
        return { select: () => ({ eq: () => ({ maybeSingle: () => mocks.recipQueue.shift() }) }) };
      }
      throw new Error(`unexpected table: ${table}`);
    },
  },
}));

import { AuthProvider, useAuth } from "./AuthProvider";

type Snapshot = { employeeId: string | null; isApprover: boolean };

function Recorder({ log }: { log: Snapshot[] }) {
  const { employee, isApprover } = useAuth();
  // 매 렌더마다 당시 값 조합을 기록한다 — 최종 상태가 아니라 "중간에 어떤 조합이
  // 실제로 화면에 커밋됐는가"를 검증하는 것이 이 테스트의 목적이다.
  log.push({ employeeId: employee?.id ?? null, isApprover });
  return null;
}

async function flushMicrotasks() {
  // setTimeout(0)은 매크로태스크라서, 그 전에 큐잉된 마이크로태스크(프라미스 체인)가
  // 전부 소진된 뒤에야 실행된다 — 몇 단계의 await를 거치는지 세지 않고도
  // "이 시점까지 나올 수 있는 렌더는 다 나왔다"를 보장하는 안전한 플러시 방법이다.
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

describe("AuthProvider — employee/isApprover 원자성", () => {
  it("재인증 도중 새 employee가 이전 isApprover와 짝지어지는 렌더가 없다", async () => {
    const log: Snapshot[] = [];

    // 1회차(마운트): user A → employees A → alert_recipients: A는 수신자(isApprover=true)
    const userA = deferred<{ data: { user: { id: string } | null } }>();
    const empAResp = deferred<{ data: Employee | null }>();
    const recipAResp = deferred<{ data: unknown }>();
    mocks.userQueue.push(userA.promise);
    mocks.empQueue.push(empAResp.promise);
    mocks.recipQueue.push(recipAResp.promise);

    render(
      <AuthProvider>
        <Recorder log={log} />
      </AuthProvider>,
    );

    await act(async () => {
      userA.resolve({ data: { user: { id: "u-a" } } });
    });
    await act(async () => {
      empAResp.resolve({ data: empA });
    });
    await act(async () => {
      recipAResp.resolve({ data: { employee_id: empA.id } });
    });

    await waitFor(() =>
      expect(log[log.length - 1]).toEqual({ employeeId: "emp-a", isApprover: true }),
    );

    // 2회차(재인증, onAuthStateChange 재호출): user B(비수신자)로 전환.
    // employees 조회는 먼저 응답시키고 alert_recipients는 일부러 늦게 응답시켜서,
    // 그 사이에 "새 employee(B) + 이전 isApprover(true)" 조합이 커밋되는지 관찰한다.
    const userB = deferred<{ data: { user: { id: string } | null } }>();
    const empBResp = deferred<{ data: Employee | null }>();
    const recipBResp = deferred<{ data: unknown }>();
    mocks.userQueue.push(userB.promise);
    mocks.empQueue.push(empBResp.promise);
    mocks.recipQueue.push(recipBResp.promise);

    await act(async () => {
      mocks.authChangeCb?.();
      userB.resolve({ data: { user: { id: "u-b" } } });
    });

    await act(async () => {
      empBResp.resolve({ data: empB });
    });
    // alert_recipients는 아직 응답하지 않았다. 여기서 큐잉된 마이크로태스크를
    // 모두 흘려보내도 "emp-b + isApprover:true" 조합의 렌더가 나오면 안 된다 —
    // 나오면 employee와 isApprover가 따로 커밋된다는 뜻이므로 버그가 재발한 것이다.
    await flushMicrotasks();

    expect(log).not.toContainEqual({ employeeId: "emp-b", isApprover: true });
    // employees 응답만으로는 아직 아무 것도 커밋되지 않아야 한다 — 여전히 1회차 상태.
    expect(log[log.length - 1]).toEqual({ employeeId: "emp-a", isApprover: true });

    await act(async () => {
      recipBResp.resolve({ data: null });
    });

    await waitFor(() =>
      expect(log[log.length - 1]).toEqual({ employeeId: "emp-b", isApprover: false }),
    );

    // 전체 렌더 이력을 통틀어 그 조합이 단 한 번도 없었는지 최종 확인한다.
    expect(log).not.toContainEqual({ employeeId: "emp-b", isApprover: true });
  });
});
