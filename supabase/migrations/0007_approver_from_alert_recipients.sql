-- 승인 권한의 출처를 employees.role='approver'에서 alert_recipients 등록 여부로 옮긴다.
--
-- 배경: 화면(Criteria.tsx)은 Alert 수신자를 "승인 권한자"라고 안내하는데 실제 승인 게이트는
-- role='approver'를 보고 있었다. 두 목록이 어긋나 "승인 요청 DM은 받는데 승인은 못 하는"
-- 상태가 운영에서 발생했다(2026-08-13). 승인 요청을 받는 사람과 승인할 수 있는 사람은
-- 정의상 같아야 하므로 alert_recipients를 유일한 출처로 삼는다.
--
-- security definer가 필요한 이유는 기존 current_emp_id()/current_emp_role()과 같다 —
-- 정책 평가 중 employees·alert_recipients를 읽어야 하는데 그 조회 자체가 RLS에 걸리면 순환한다.

create or replace function current_emp_is_approver() returns boolean
language sql stable security definer set search_path = public as
$$ select exists (
     select 1 from alert_recipients where employee_id = current_emp_id()
   ) $$;

drop policy if exists w_approver on messages;
create policy w_approver on messages for update
  using (current_emp_is_approver()) with check (current_emp_is_approver());
