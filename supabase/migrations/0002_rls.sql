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

-- 브리프 외 추가: 로컬 스택에서 authenticated 롤에 테이블 privilege가 없어
-- RLS 정책 평가 이전에 "permission denied"가 발생 → 테이블 레벨 GRANT 필요.
-- GRANT는 스펙 매트릭스보다 좁게 스코프됨 (observations/events/heartbeats/dispatches는 select만).
-- 실제 접근 제어는 RLS 정책이 담당하며, GRANT는 그 전제 조건일 뿐임.

-- 인증된 사용자 기본 권한 (RLS 정책과 함께 작동)
grant select, update on site_settings to authenticated;
grant select, update on weather_criteria to authenticated;
grant select, update on alert_settings to authenticated;
grant select, insert, update, delete on departments to authenticated;
grant select, insert, update, delete on employees to authenticated;
grant select, insert, update, delete on recipients to authenticated;
grant select, insert, update, delete on alert_recipients to authenticated;
grant select, insert, update, delete on action_guidelines to authenticated;
grant select on weather_observations to authenticated;
grant select on weather_events to authenticated;
grant select, update on messages to authenticated;
grant select on dispatches to authenticated;
grant select on heartbeats to authenticated;

-- Service role 권한 (Edge Functions 및 초기 설정)
grant select, insert, update, delete on site_settings to service_role;
grant select, insert, update, delete on weather_criteria to service_role;
grant select, insert, update, delete on alert_settings to service_role;
grant select, insert, update, delete on departments to service_role;
grant select, insert, update, delete on employees to service_role;
grant select, insert, update, delete on recipients to service_role;
grant select, insert, update, delete on alert_recipients to service_role;
grant select, insert, update, delete on action_guidelines to service_role;
grant select, insert, update, delete on weather_observations to service_role;
grant select, insert, update, delete on weather_events to service_role;
grant select, insert, update, delete on messages to service_role;
grant select, insert, update, delete on dispatches to service_role;
grant select, insert, update, delete on heartbeats to service_role;
