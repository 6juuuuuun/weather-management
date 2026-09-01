-- 직원을 삭제해도 "누가 승인했는가"가 남게 한다 (QA W-01 · 사용자 결정 D-1).
--
-- 사용자 결정: **직원을 삭제하면 로그인 계정도 함께 삭제한다. 단 승인자 이름은
-- 이력에 남긴다.** 안전 경보 시스템에서 "누가 이 특보를 승인했는가"는 그 사람이
-- 퇴사했다고 사라져서는 안 된다. 이름만 남기고 링크(외래키)를 끊는 것이 그 절충이다.
--
-- 지금 상태의 문제는 두 겹이다.
--   1) weather_events.approved_by / messages.updated_by / action_guidelines.updated_by가
--      전부 on delete NO ACTION이라, **특보를 한 번이라도 승인한 사람은 아예 지워지지
--      않는다.** 관리자 화면에는 그 실패가 `서버 오류가 발생했습니다`(500)로만 보인다.
--   2) 그렇다고 cascade로 지우면 특보 이력 자체가 사라지고, set null만 하면
--      "승인: (모름)"이 된다 — 둘 다 책임 추적을 잃는다.
--
-- 그래서 이름 스냅샷 컬럼을 더하고 외래키를 on delete set null로 바꾼다.
-- 삭제 후에는 id는 null이지만 이름은 남고, 화면은 id가 없는 이름을
-- "홍길동(삭제된 직원)"으로 보여 준다 — 지워졌다는 사실까지 드러난다.
--
-- 기존 파일을 고치지 않고 새 파일로 더한다 — 이미 적용된 데이터베이스와 어긋나지
-- 않게 하는 것이 이 폴더의 규칙이다(0012의 같은 주석 참고).
begin;

alter table weather_events    add column if not exists approved_by_name text;
alter table messages          add column if not exists updated_by_name  text;
alter table action_guidelines add column if not exists updated_by_name  text;

-- 이미 쌓인 행은 이름이 비어 있다. 지금 employees에 아직 남아 있는 사람은 여기서
-- 채워 둔다 — 이 마이그레이션 이후에 삭제되면 그 이름이 이력에 남는다. 이 시점에
-- 이미 참조가 끊긴(= 애초에 없는) id는 채울 방법이 없으므로 null로 둔다.
update weather_events e set approved_by_name = emp.name
  from employees emp where emp.id = e.approved_by and e.approved_by_name is null;
update messages m set updated_by_name = emp.name
  from employees emp where emp.id = m.updated_by and m.updated_by_name is null;
update action_guidelines g set updated_by_name = emp.name
  from employees emp where emp.id = g.updated_by and g.updated_by_name is null;

-- 외래키를 on delete set null로 바꾼다. 제약 이름은 0001_schema.sql이 컬럼 정의에
-- 붙인 references가 Postgres 기본 규칙(<table>_<column>_fkey)으로 만든 것이다.
-- drop 후 add라 이름이 바뀌지 않게 같은 이름으로 다시 만든다.
alter table weather_events drop constraint if exists weather_events_approved_by_fkey;
alter table weather_events add constraint weather_events_approved_by_fkey
  foreign key (approved_by) references employees(id) on delete set null;

alter table messages drop constraint if exists messages_updated_by_fkey;
alter table messages add constraint messages_updated_by_fkey
  foreign key (updated_by) references employees(id) on delete set null;

alter table action_guidelines drop constraint if exists action_guidelines_updated_by_fkey;
alter table action_guidelines add constraint action_guidelines_updated_by_fkey
  foreign key (updated_by) references employees(id) on delete set null;

commit;
