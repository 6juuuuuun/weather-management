import { describe, expect, it, vi, beforeEach } from "vitest";
import { act, render, waitFor } from "@testing-library/react";
import type { MutableRefObject } from "react";
import { AuthProvider, useAuth } from "./AuthProvider";
import type { Employee } from "../lib/types";

beforeEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

// 경로별로 응답을 하나씩 소비하는 큐. AuthProvider가 같은 경로(/api/auth/me 등)를
// 재인증마다 다시 부르므로, 테스트가 각 호출의 응답 타이밍을 직접 통제하려면
// 경로마다 별도 대기열이 필요하다.
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function makeFetchMock() {
  const queues = new Map<string, Promise<Response>[]>();
  const push = (path: string, promise: Promise<Response>) => {
    const q = queues.get(path) ?? [];
    q.push(promise);
    queues.set(path, q);
  };
  const fetchMock = vi.fn((path: string) => {
    const q = queues.get(path);
    if (!q || q.length === 0) throw new Error(`no mock response queued for ${path}`);
    return q.shift()!;
  });
  return { fetchMock, push };
}

const empA: Employee = {
  id: "emp-a",
  auth_user_id: "u-a",
  name: "A",
  email: "a@example.com",
  notifiable: false,
  department_id: null,
  role: "approver",
  phone: null,
  created_at: "2026-01-01T00:00:00Z",
};

const empB: Employee = {
  id: "emp-b",
  auth_user_id: "u-b",
  name: "B",
  email: "b@example.com",
  notifiable: false,
  department_id: null,
  role: "approver",
  phone: null,
  created_at: "2026-01-01T00:00:00Z",
};

type Snapshot = { employeeId: string | null; isApprover: boolean };
type LoginFn = (email: string, password: string) => Promise<{ mustChangePassword: boolean }>;

function Recorder({ log, loginRef }: { log: Snapshot[]; loginRef: MutableRefObject<LoginFn | null> }) {
  const { employee, isApprover, login } = useAuth();
  loginRef.current = login;
  // 매 렌더마다 당시 값 조합을 기록한다 — 최종 상태가 아니라 "중간에 어떤 조합이
  // 실제로 화면에 커밋됐는가"를 검증하는 것이 이 테스트의 목적이다.
  log.push({ employeeId: employee?.id ?? null, isApprover });
  return null;
}

function Harness({ log, loginRef }: { log: Snapshot[]; loginRef: MutableRefObject<LoginFn | null> }) {
  return (
    <AuthProvider>
      <Recorder log={log} loginRef={loginRef} />
    </AuthProvider>
  );
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
    const { fetchMock, push } = makeFetchMock();
    vi.stubGlobal("fetch", fetchMock);

    const log: Snapshot[] = [];
    const loginRef: MutableRefObject<LoginFn | null> = { current: null };

    // 1회차(마운트): /api/auth/me → A, /api/employees → [A], /api/alert-recipients → A는 수신자.
    const meA = deferred<Response>();
    const empsA = deferred<Response>();
    const recipsA = deferred<Response>();
    push("/api/auth/me", meA.promise);
    push("/api/employees", empsA.promise);
    push("/api/alert-recipients", recipsA.promise);

    render(<Harness log={log} loginRef={loginRef} />);

    await act(async () => {
      meA.resolve(
        jsonResponse({
          user: {
            accountId: "acc-a",
            employeeId: "emp-a",
            role: "approver",
            email: "a@example.com",
            mustChangePassword: false,
          },
        }),
      );
    });
    await act(async () => {
      empsA.resolve(jsonResponse([empA]));
    });
    await act(async () => {
      recipsA.resolve(jsonResponse([{ employee_id: "emp-a", name: "A", role: "approver" }]));
    });

    await waitFor(() =>
      expect(log[log.length - 1]).toEqual({ employeeId: "emp-a", isApprover: true }),
    );

    // 2회차(재인증): login()을 다시 호출해 B(비수신자)로 전환한다.
    // employees 조회는 먼저 응답시키고 alert_recipients는 일부러 늦게 응답시켜서,
    // 그 사이에 "새 employee(B) + 이전 isApprover(true)" 조합이 커밋되는지 관찰한다.
    const loginB = deferred<Response>();
    const meB = deferred<Response>();
    const empsB = deferred<Response>();
    const recipsB = deferred<Response>();
    push("/api/auth/login", loginB.promise);
    push("/api/auth/me", meB.promise);
    push("/api/employees", empsB.promise);
    push("/api/alert-recipients", recipsB.promise);

    let loginPromise!: Promise<unknown>;
    await act(async () => {
      loginPromise = loginRef.current!("b@example.com", "password12345");
      loginB.resolve(
        jsonResponse({
          user: {
            accountId: "acc-b",
            employeeId: "emp-b",
            role: "approver",
            email: "b@example.com",
            mustChangePassword: false,
          },
          must_change_password: false,
        }),
      );
    });
    await act(async () => {
      meB.resolve(
        jsonResponse({
          user: {
            accountId: "acc-b",
            employeeId: "emp-b",
            role: "approver",
            email: "b@example.com",
            mustChangePassword: false,
          },
        }),
      );
    });
    await act(async () => {
      empsB.resolve(jsonResponse([empA, empB]));
    });
    // alert_recipients는 아직 응답하지 않았다. 여기서 큐잉된 마이크로태스크를
    // 모두 흘려보내도 "emp-b + isApprover:true" 조합의 렌더가 나오면 안 된다 —
    // 나오면 employee와 isApprover가 따로 커밋된다는 뜻이므로 버그가 재발한 것이다.
    await flushMicrotasks();

    expect(log).not.toContainEqual({ employeeId: "emp-b", isApprover: true });
    // employees 응답만으로는 아직 아무 것도 커밋되지 않아야 한다 — 여전히 1회차 상태.
    expect(log[log.length - 1]).toEqual({ employeeId: "emp-a", isApprover: true });

    await act(async () => {
      recipsB.resolve(jsonResponse([]));
    });
    await act(async () => {
      await loginPromise;
    });

    await waitFor(() =>
      expect(log[log.length - 1]).toEqual({ employeeId: "emp-b", isApprover: false }),
    );

    // 전체 렌더 이력을 통틀어 그 조합이 단 한 번도 없었는지 최종 확인한다.
    expect(log).not.toContainEqual({ employeeId: "emp-b", isApprover: true });
  });
});
