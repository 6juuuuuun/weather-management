-- 재알림 횟수를 따로 센다 (QA W-26).
--
-- 화면의 "재알림 N회" 배지는 weather_events.repeat_count를 읽는데, 그 값은
-- **승인 시점에 1로 세팅되고 반복 발송마다 오르는 발송 회차**다(send.ts, weatherTick.ts).
-- 승인 대기 특보의 repeat_count는 기본값 0에서 움직이지 않으므로, 30분마다 재알림이
-- 나가도 배지는 영원히 "재알림 0회"였다. 승인자가 얼마나 오래 방치했는지가 화면에서
-- 지워진 셈이다.
--
-- 두 숫자는 뜻이 다르므로 컬럼을 나눈다: repeat_count = 발송 회차,
-- remind_count = 승인 재촉 횟수. remindTick이 이 값을 올리고, 상한(REMIND_LIMIT)에
-- 도달하면 재알림을 멈추고 관리자에게 따로 알린다 — 승인자가 반응하지 않는다는
-- 사실 자체가 관리자가 알아야 할 정보다(사용자 결정).
--
-- 기존 파일을 고치지 않고 새 파일로 더한다.
begin;

alter table weather_events add column if not exists remind_count int not null default 0;

commit;
