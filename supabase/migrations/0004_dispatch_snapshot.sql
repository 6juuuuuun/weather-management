-- 발송 시점 내용 불변 스냅샷 (재발송으로 messages.content가 갱신되어도 과거 이력 보존)
alter table dispatches add column content jsonb;

-- weather_criteria: upsert(INSERT ... ON CONFLICT)가 문장 레벨 INSERT 권한을 요구함
grant insert on weather_criteria to authenticated;
create policy w_admin_ins on weather_criteria for insert with check (current_emp_role() = 'admin');
