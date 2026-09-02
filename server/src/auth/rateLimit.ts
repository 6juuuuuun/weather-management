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
// **(1)이 (2)를 무력화하지 않게 하는 것이 이 파일의 핵심이다**(검증 라운드 E).
// 두 방어는 각각 동작했는데 합치자 서로를 죽였다: 429 관문이 (2)보다 **앞에** 있어서,
// 공격자가 이메일 창을 계속 채우면 본인의 정답 로그인까지 429로 막혔다. 관문의 순서를
// 바꾸는 것으로는 못 고친다 — 순서를 바꾸면 "정답인지 보려면 해시 검증을 해야 하고,
// 그 비용이 곧 이 창이 묶으려던 것"이라 창 자체가 무의미해진다. **키를 고친다:**
// 창을 (이메일, 출처 IP)로 잡아, 공격자가 자기 비용을 남의 계정에 떠넘길 수 없게 한다.
//
// 전제: 앱이 클라이언트 IP를 **그대로** 본다(compose가 포트를 직접 노출하고,
// 앞에 리버스 프록시가 없다). 나중에 프록시를 앞에 둔다면 `app.set("trust proxy", ...)`를
// 함께 켜야 한다 — 그러지 않으면 모든 사내 PC가 프록시 IP 하나로 보여
// 이 창이 다시 "이메일 단위"로 퇴화한다. 안내서 §6-3에 같은 말을 적어 둔다.
//
// 저장소는 프로세스 메모리다. 이 앱은 단일 컨테이너 단일 프로세스로 돌고(compose),
// 재시작하면 초기화된다 — 재시작으로 초기화되는 것은 공격자에게 의미 있는 이득이
// 아니다(그는 재시작을 일으킬 수 없다). Redis 같은 의존성을 새로 들이지 않는다
// (package.json 변경 금지, 그리고 사내망 단일 서버 배포에 그럴 이유도 없다).

/**
 * **한 이메일 × 한 출처(IP)** 에 대한 실패 허용치와 창(窓).
 * 사람의 오타 3~5회는 여기에 닿지 않는다.
 *
 * **왜 이메일만으로 세지 않는가**(검증 라운드 E, 항목 1 PARTIAL): 이메일만으로 세면
 * 그 창을 **제3자가 채울 수 있다.** 승인권자의 이메일만 알면 10분마다 오입력 12회
 * (자동화로 사실상 공짜)로 그 이메일의 창을 계속 채워, **본인이 올바른 비밀번호를
 * 넣어도 429로 막았다.** 바로 옆에서 고친 "잠겨 있어도 정답은 통과"(routes.ts)가
 * 그 429 관문 뒤에 있어 통째로 무력화됐고, 문서화된 관리자 복구(비활성화→활성화)는
 * 메모리 버킷을 비우지 않아 듣지도 않았다. 즉 W-17(이메일만 알면 승인권자를 무기한
 * 로그인 불가로 둔다)이 **비용만 오른 채 그대로 살아 있었다.**
 *
 * 그래서 이 창의 키에 **공격자가 남에게 떠넘길 수 없는 값**을 넣는다: 출처 IP다.
 * 공격자의 시도는 공격자의 (이메일,IP) 칸을 채우고, 승인권자가 자기 자리에서 넣는
 * 정답은 자기 칸(실패 0회)으로 들어와 막히지 않는다. **비용은 그것을 만든 쪽이 낸다.**
 *
 * 그러면 "한 계정에 대한 찍어 맞히기"는 무엇이 막는가 — **계정 잠금**이다(5회/15분,
 * 출처와 무관하게 계정 단위로 건다). 그 잠금은 정답을 아는 본인을 막지 않으므로
 * (routes.ts) 제3자의 무기한 잠금 도구가 되지 않는다. 두 겹의 역할이 다르다:
 * 잠금은 **계정별 추측 횟수**를, 이 창과 IP 창은 **출처별 자동화 비용**을 묶는다.
 */
export const EMAIL_IP_LIMIT = 12;
export const EMAIL_IP_WINDOW_SEC = 600;
/** 한 IP에 대한 실패 허용치. 이메일을 바꿔 가며 두드리는 쪽을 잡는다(검증: 30개 이메일 1초). */
export const IP_LIMIT = 40;
export const IP_WINDOW_SEC = 600;

type Bucket = { hits: number[] };

/** (이메일, 출처 IP) 한 쌍의 키. 이메일에 개행이 들어갈 수 없으므로 구분자로 쓴다. */
const emailIpKey = (email: string, ip: string) => `${email}\n${ip}`;

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
  /** 키가 (이메일, IP)다 — 이메일만으로 세면 제3자가 남의 창을 채울 수 있다(위 주석). */
  private byEmailIp = new Map<string, Bucket>();
  private byIp = new Map<string, Bucket>();
  /** 테스트가 시간을 갈아 끼운다. 운영에서는 언제나 Date.now다. */
  constructor(private now: () => number = () => Date.now()) {}

  /**
   * 지금 이 시도를 받아도 되는가. **기록하지 않는다** — 실패했을 때만 record가 남긴다.
   * 성공한 로그인이 창을 채우면 정상 사용자가 자기 자신을 잠그게 된다.
   */
  check(key: { email: string; ip: string }): RateVerdict {
    const now = this.now();
    const e = prune(this.byEmailIp, emailIpKey(key.email, key.ip), EMAIL_IP_WINDOW_SEC, now);
    if (e && e.hits.length >= EMAIL_IP_LIMIT) {
      return { limited: true, retryAfterSec: retryAfter(e, EMAIL_IP_WINDOW_SEC, now) };
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
      [this.byEmailIp, emailIpKey(key.email, key.ip)],
      [this.byIp, key.ip],
    ] as const) {
      const b = store.get(k) ?? { hits: [] };
      b.hits.push(now);
      store.set(k, b);
    }
  }

  /**
   * 그 이메일의 실패 기록을 **출처를 가리지 않고 전부** 지운다.
   *
   * 두 곳에서 부른다.
   *  - 로그인 성공(routes.ts) — 본인이 들어왔으면 공격이 아니다.
   *  - **관리자 복구**(계정 비활성화→활성화 · 임시 비밀번호 발급) — 안내서 §6-3이
   *    알려 주는 유일한 웹 복구 경로다. 예전에는 이 호출이 없어서 관리자가 계정을
   *    풀어 줘도(failed_attempts·locked_until만 지워졌다) 메모리의 속도 제한 버킷이
   *    그대로 남아 **여전히 429**였다 — 문서가 약속한 복구가 실제로는 듣지 않았고,
   *    실질 복구가 앱 재시작뿐이었다(안내서에 없고 모든 창을 함께 날린다).
   *
   * IP 창은 지우지 않는다. 그쪽까지 비우면, 관리자가 한 사람을 풀어 주는 행동이
   * 같은 IP에서 두드리던 자동화의 예산까지 되돌려 준다.
   */
  clear(email: string): void {
    const prefix = `${email}\n`;
    for (const k of [...this.byEmailIp.keys()]) {
      if (k.startsWith(prefix)) this.byEmailIp.delete(k);
    }
  }

  /** 테스트 전용. 운영 코드에서 부르지 않는다. */
  reset(): void {
    this.byEmailIp.clear();
    this.byIp.clear();
  }
}

function retryAfter(b: Bucket, windowSec: number, now: number): number {
  const oldest = b.hits[0] ?? now;
  return Math.max(1, Math.ceil((oldest + windowSec * 1000 - now) / 1000));
}

/** 앱 전체가 쓰는 하나. 라우트가 이것을 참조한다. */
export const loginRateLimiter = new LoginRateLimiter();
