-- 발송 회차(repeat_no) 채번 단일화 보증
--
-- 회차는 weather_events.repeat_count를 유일 기준으로 채번한다:
--   승인(send approve) = 1회차이자 repeat_count=1, 이후 자동 반복(weather-tick)과
--   재발송(send resend) 모두 repeat_count+1로 채번하고 repeat_count를 갱신한다.
-- 예전에는 approve=리터럴 1 / repeat=repeat_count+1 / resend=count(dispatches)+1로
-- 세 곳에서 따로 채번해, 승인과 첫 반복이 둘 다 1회차로 기록되고 재발송은 2를 건너뛰었다.
--
-- 부분 유니크 인덱스로 실 발송 이력의 회차 중복을 DB 차원에서 막는다.
-- 테스트 발송(is_test = true)은 회차 개념이 없으므로 제외한다.
create unique index dispatches_event_repeat_uniq
  on dispatches (event_id, repeat_no)
  where is_test = false;
