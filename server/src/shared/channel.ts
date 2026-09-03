/**
 * 특보 본문을 사람에게 내보내는 통로.
 *
 * `to`는 **휴대폰 번호**다(`010-1234-5678` 정규형 — server/src/phone.ts).
 * 카카오워크 시절에는 이 자리가 카카오워크 user id였고, 그 값은 이메일 조회로
 * 채워야 했다. 전화번호는 번호 자체가 주소라 조회 단계가 아예 없다.
 */
export interface NotificationChannel {
  /**
   * 이 채널의 이름. `dispatches.channel`에 그대로 남는다.
   *
   * 예전에는 인터페이스에 이름을 넣을 수 없어(shared/가 원본과 바이트 동일이어야
   * 했다) 호출부가 `instanceof`로 알아냈다. 그 제약이 풀렸으므로 채널이 스스로
   * 이름을 말한다 — 이력에 "어디로 나갔는가"를 적는 값이니 채널 본인이 답하는 것이
   * 맞다. 선택 항목인 이유는 테스트가 주입하는 대역 때문이다(이름이 없으면
   * `channelName`이 "custom"으로 적는다 — 실제 채널인 척하는 것보다 낫다).
   */
  readonly name?: string;
  send(to: string, text: string): Promise<{ ok: boolean; error?: string }>;
}
