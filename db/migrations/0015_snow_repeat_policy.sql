-- 폭설 반복·해제 정책을 누적 적설에 맞는 값으로 바꾼다 (QA W-04).
--
-- 폭설 판정은 **당일(KST 자정 이후) 누적 적설**을 본다
-- (server/src/shared/engine.ts의 exceeds("snow") → obs.snowToday).
-- 그런데 시드가 심은 정책은 hourly_until_below("매시간 관측이 기준 미만이면 해제")였다.
-- 누적값은 눈이 그쳐도 자정까지 줄어들지 않으므로 그 정책에서는
--   · 반복 조건: 항상 참  → 눈이 그친 뒤에도 매시간 같은 DM이 나간다
--   · 해제 조건: 항상 거짓 → 자정까지 절대 해제되지 않는다
-- QA 실측: 신적설 0인데 반복 발송 3회. 겨울 오후에 5cm를 한 번 넘기면 제설 담당자는
-- 눈이 완전히 그친 뒤에도 자정까지 매시간 같은 폭설 주의보를 받고, 그 다음부터 아무도 읽지 않는다.
--
-- engine.ts의 주석이 정확히 이 함정을 경고하면서 그것을 피하라고 만들어 둔 정책이
-- until_daily_accum_below다("누적은 반복을 계속할 이유로만 쓰고, 해제는 강수·강설
-- 중단으로 판정한다" — 스펙 §5, 2026-08-12). rain에는 켜져 있고 snow에는 꺼져 있었다.
-- 즉 **코드가 아니라 이 데이터 값이 틀렸다.** engine.ts는 손대지 않는다(바이트 동일성).
--
-- repeat_accum_threshold는 snow에서 null로 둔다. rain은 시간당 강수량으로 판정하므로
-- "약하게 계속 오는데 누적이 많은" 경우를 위해 별도 임계(80mm)가 필요하지만,
-- snow는 exceeds()가 이미 누적(snowToday)을 보므로 그 절이 중복이다.
--
-- 조건부로 바꾼다: 운영자가 손대지 않은(= 시드 기본값 그대로인) 경우에만 고친다.
-- 기존 파일을 고치지 않고 새 파일로 더한다(0012~0014와 같은 이유).
begin;

update alert_settings
   set repeat_policy = 'until_daily_accum_below',
       repeat_accum_threshold = null,
       updated_at = now()
 where kind = 'snow'
   and repeat_policy = 'hourly_until_below';

commit;
