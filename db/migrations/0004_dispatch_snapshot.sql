-- 발송 시점 내용 불변 스냅샷 (재발송으로 messages.content가 갱신되어도 과거 이력 보존)
alter table dispatches add column content jsonb;

-- weather_criteria: upsert(INSERT ... ON CONFLICT)가 문장 레벨 INSERT 권한을 요구함.
-- 원본은 여기서 Supabase 내장 롤 authenticated에 GRANT했지만, 자체 호스팅에는 그 롤이
-- 없다 — 0008_selfhost_auth.sql이 app_user/app_service에 이미 더 넓게 GRANT하므로 생략한다.
create policy w_admin_ins on weather_criteria for insert with check (current_emp_role() = 'admin');
