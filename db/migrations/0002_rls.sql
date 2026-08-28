-- auth.uid()는 0008_selfhost_auth.sql이 정의하는데, 그 파일은 파일명 순서상 이 파일보다
-- 뒤에 적용된다(0001~0007은 Supabase 원본 이력을 그대로 보존하려고 번호를 바꾸지 않았다).
-- check_function_bodies를 끄지 않으면 이 함수를 만드는 시점에 auth 스키마가 없어서
-- CREATE FUNCTION 자체가 실패한다 — 실제 호출은 항상 0008 적용 이후에 일어나므로 안전하다.
set check_function_bodies = off;

create function current_emp_id() returns uuid
language sql stable security definer set search_path = public as
$$ select id from employees where auth_user_id = auth.uid() $$;

create function current_emp_role() returns emp_role
language sql stable security definer set search_path = public as
$$ select role from employees where auth_user_id = auth.uid() $$;

alter table site_settings enable row level security;
alter table weather_criteria enable row level security;
alter table alert_settings enable row level security;
alter table departments enable row level security;
alter table employees enable row level security;
alter table recipients enable row level security;
alter table alert_recipients enable row level security;
alter table action_guidelines enable row level security;
alter table weather_observations enable row level security;
alter table weather_events enable row level security;
alter table messages enable row level security;
alter table dispatches enable row level security;
alter table heartbeats enable row level security;

-- 읽기: 로그인한 전 역할 (지침은 staff는 자기 부서만)
create policy r_all on site_settings for select using (auth.uid() is not null);
create policy r_all on weather_criteria for select using (auth.uid() is not null);
create policy r_all on alert_settings for select using (auth.uid() is not null);
create policy r_all on departments for select using (auth.uid() is not null);
create policy r_all on employees for select using (auth.uid() is not null);
create policy r_all on recipients for select using (auth.uid() is not null);
create policy r_all on alert_recipients for select using (auth.uid() is not null);
create policy r_all on weather_observations for select using (auth.uid() is not null);
create policy r_all on weather_events for select using (auth.uid() is not null);
create policy r_all on dispatches for select using (auth.uid() is not null);
create policy r_all on heartbeats for select using (auth.uid() is not null);
create policy r_guidelines on action_guidelines for select using (
  current_emp_role() in ('admin','approver')
  or department_id = (select department_id from employees where id = current_emp_id())
);
create policy r_messages on messages for select using (auth.uid() is not null);

-- 쓰기: admin = 마스터 전체
create policy w_admin on site_settings for update using (current_emp_role() = 'admin');
create policy w_admin on weather_criteria for update using (current_emp_role() = 'admin');
create policy w_admin on alert_settings for update using (current_emp_role() = 'admin');
create policy w_admin_ins on departments for insert with check (current_emp_role() = 'admin');
create policy w_admin_upd on departments for update using (current_emp_role() = 'admin');
create policy w_admin_del on departments for delete using (current_emp_role() = 'admin');
create policy w_admin_ins on employees for insert with check (current_emp_role() = 'admin');
create policy w_admin_upd on employees for update using (current_emp_role() = 'admin');
create policy w_admin_del on employees for delete using (current_emp_role() = 'admin');
create policy w_admin_all on recipients for all using (current_emp_role() = 'admin');
create policy w_admin_all on alert_recipients for all using (current_emp_role() = 'admin');
create policy w_admin_all on action_guidelines for all using (current_emp_role() = 'admin');

-- approver: 초안 수정만 (발송·상태 전이는 send Edge Function이 service role로 수행)
create policy w_approver on messages for update
  using (current_emp_role() = 'approver') with check (current_emp_role() = 'approver');

-- dispatches: 클라이언트 쓰기 전면 금지 (Edge Function 전용) — insert/update/delete 정책 없음

-- 자체 호스팅 이관: 원본은 여기서 Supabase 내장 롤 authenticated/service_role에
-- 테이블 GRANT를 걸었다(RLS 평가 이전 단계의 permission denied를 막는 전제 조건).
-- 자체 Postgres에는 그 두 롤이 없고, 대신 0008_selfhost_auth.sql이 이 역할을 이어받는
-- app_user/app_service에 "all tables in schema public" 기준으로 이미 더 넓게 GRANT한다.
-- 그래서 이 블록은 이관하지 않는다 — RLS 정책 자체(위 create policy)는 한 줄도 건드리지 않았다.
