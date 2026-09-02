// 로그인 시도 속도 제한.
//
// **왜 잠금만으로는 부족한가**(검증 W-17, Critical): 비밀번호 5회 실패 → 15분 잠금은
// 무차별 대입을 늦추지만, **그 잠금 자체가 공격 도구가 된다.** 승인권자의 이메일만
// 알면 15분마다 요청 5개(1분에 1개도 안 된다)로 그 사람을 영구히 로그인 불가 상태로
// 둘 수 있다. 폭설이 와도 특보를 승인할 사람이 아무도 없다.
//
// 이전 라운드에서 컨트롤러는 이것을 "보이게 만드는 것이 목적, 잠금 정책 변경은 범위
// 밖"으로 잡았고 그 판단이 틀렸다고 스스로 기록했다: **피해가 '값이 싸다'에서 나올 때,
// 보이게 만드는 것은 값을 올리지 못한다.**
//
// 그래서 두 가지를 같이 한다.
//  (1) 여기(속도 제한) — 자동화된 반복이 사람의 오타와 다른 값을 치르게 한다.
//  (2) routes.ts — **잠긴 계정이라도 올바른 비밀번호는 통과시킨다.** 잠금의 목적은
//      "찍어 맞히기"를 막는 것이지 비밀번호를 아는 본인을 막는 것이 아니다. 이 한 줄이
//      "이메일만 알면 무기한 잠근다"를 성립하지 않게 만든다. 그 대신 잠긴 계정에도
//      해시 검증 비용이 들므로, 그 비용을 (1)이 묶는다.
//
// 저장소는 프로세스 메모리다. 이 앱은 단일 컨테이너 단일 프로세스로 돌고(compose),
// 재시작하면 초기화된다 — 재시작으로 초기화되는 것은 공격자에게 의미 있는 이득이
// 아니다(그는 재시작을 일으킬 수 없다). Redis 같은 의존성을 새로 들이지 않는다
// (package.json 변경 금지, 그리고 사내망 단일 서버 배포에 그럴 이유도 없다).

/** 한 이메일에 대한 실패 허용치와 창(窓). 사람의 오타 3~5회는 여기에 닿지 않는다. */
export const EMAIL_LIMIT = 12;
export const EMAIL_WINDOW_SEC = 600;
/** 한 IP에 대한 실패 허용치. 이메일을 바꿔 가며 두드리는 쪽을 잡는다(검증: 30개 이메일 1초). */
export const IP_LIMIT = 40;
export const IP_WINDOW_SEC = 600;

type Bucket = { hits: number[] };

/** 창 밖으로 나간 기록을 버린다. 버킷이 비면 지운다 — 메모리가 무한히 자라지 않게. */
function prune(store: Map<string, Bucket>, key: string, windowSec: number, now: number): Bucket | null {
  const b = store.get(key);
  if (!b) return null;
  const cutoff = now - windowSec * 1000;
  b.hits = b.hits.filter((t) => t > cutoff);
  if (b.hits.length === 0) {
    store.delete(key);
    return null;
  }
  return b;
}

export type RateVerdict = { limited: boolean; retryAfterSec: number };

export class LoginRateLimiter {
  private byEmail = new Map<string, Bucket>();
  private byIp = new Map<string, Bucket>();
  /** 테스트가 시간을 갈아 끼운다. 운영에서는 언제나 Date.now다. */
  constructor(private now: () => number = () => Date.now()) {}

  /**
   * 지금 이 시도를 받아도 되는가. **기록하지 않는다** — 실패했을 때만 record가 남긴다.
   * 성공한 로그인이 창을 채우면 정상 사용자가 자기 자신을 잠그게 된다.
   */
  check(key: { email: string; ip: string }): RateVerdict {
    const now = this.now();
    const e = prune(this.byEmail, key.email, EMAIL_WINDOW_SEC, now);
    if (e && e.hits.length >= EMAIL_LIMIT) {
      return { limited: true, retryAfterSec: retryAfter(e, EMAIL_WINDOW_SEC, now) };
    }
    const i = prune(this.byIp, key.ip, IP_WINDOW_SEC, now);
    if (i && i.hits.length >= IP_LIMIT) {
      return { limited: true, retryAfterSec: retryAfter(i, IP_WINDOW_SEC, now) };
    }
    return { limited: false, retryAfterSec: 0 };
  }

  /**
   * 실패한 시도(비밀번호 오류·없는 계정·**잠긴 계정을 두드린 것**)를 기록한다.
   *
   * 잠긴 계정에 대한 시도까지 세는 것이 요점이다. 예전에는 잠긴 계정에 계속 두드리는
   * 것이 완전히 공짜였다 — 423만 돌려주고 아무 비용도 남지 않았다.
   */
  record(key: { email: string; ip: string }): void {
    const now = this.now();
    for (const [store, k] of [
      [this.byEmail, key.email],
      [this.byIp, key.ip],
    ] as const) {
      const b = store.get(k) ?? { hits: [] };
      b.hits.push(now);
      store.set(k, b);
    }
  }

  /** 로그인에 성공했다. 그 이메일의 기록을 지운다 — 본인이 들어왔으면 공격이 아니다. */
  clear(email: string): void {
    this.byEmail.delete(email);
  }

  /** 테스트 전용. 운영 코드에서 부르지 않는다. */
  reset(): void {
    this.byEmail.clear();
    this.byIp.clear();
  }
}

function retryAfter(b: Bucket, windowSec: number, now: number): number {
  const oldest = b.hits[0] ?? now;
  return Math.max(1, Math.ceil((oldest + windowSec * 1000 - now) / 1000));
}

/** 앱 전체가 쓰는 하나. 라우트가 이것을 참조한다. */
export const loginRateLimiter = new LoginRateLimiter();
