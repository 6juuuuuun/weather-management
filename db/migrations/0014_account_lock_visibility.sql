-- 반복 잠금을 관리자가 볼 수 있게 한다 (QA W-17).
--
-- 계정 잠금은 5회 실패·15분이다. 이메일만 아는 사람이 15분마다 5번씩 틀리면 그
-- 계정은 계속 잠긴 상태로 남는다 — 대상이 특보 승인권자면 승인 자체가 무기한
-- 막힌다. 잠금 정책 자체를 바꾸는 것은 이 라운드의 범위가 아니다(브리프).
-- 목적은 **그 일이 벌어지고 있다는 것이 관리자에게 보이게** 하는 것이다.
--
-- 지금은 잠겼다는 사실이 auth_accounts.locked_until에만 있고 어느 화면에도 나오지
-- 않는다. 관리자 화면은 그 계정을 여전히 "사용 중"이라고 적극적으로 말한다.
-- 잠금이 걸릴 때마다 세는 누적 횟수를 함께 둔다 — 한 번은 사람이 비밀번호를
-- 잊은 것이고, 열 번은 누가 그 계정을 겨냥하고 있다는 뜻이다. 한 순간의 상태
-- (locked_until)만으로는 그 둘을 구분할 수 없다.
--
-- 기존 파일을 고치지 않고 새 파일로 더한다(0012·0013과 같은 이유).
begin;

alter table auth_accounts add column if not exists lock_count int not null default 0;
alter table auth_accounts add column if not exists last_locked_at timestamptz;

commit;
