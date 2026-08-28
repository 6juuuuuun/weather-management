-- 기본값 시드. supabase/seed.sql을 자체 호스팅으로 그대로 옮기되, 원본은
-- site_settings에만 idempotency(on conflict do nothing)를 걸어 두고 나머지는
-- 두 번째 실행에서 그대로 깨진다 — weather_criteria/alert_settings는
-- "duplicate key", departments는 CTE가 매번 새 행을 만들어 부서가 배로
-- 늘어난다. migrate 스크립트가 배포 때마다(=여러 번) 이 파일을 적용하므로
-- 전부 몇 번을 다시 돌려도 안전하게 고쳤다. 원본에 있던 "예시 지침"
-- (action_guidelines, 곤지암 목업 문구)은 시스템 동작에 필요한 기본값이
-- 아니라 데모용 샘플이라 옮기지 않았다 — 필요하면 관리자가 화면에서 입력한다.

insert into site_settings (id) values (1) on conflict do nothing;

insert into weather_criteria (kind, grade, threshold) values
 ('rain','watch','{"rain_mm_per_hr":20}'), ('rain','warning','{"rain_mm_per_hr":50}'),
 ('snow','watch','{"snow_cm":5}'),         ('snow','warning','{"snow_cm":20}'),
 ('wind','watch','{"wind_ms":14}'),        ('wind','warning','{"wind_ms":21}'),
 ('heat','watch','{"temp_c":33,"feels_c":31}'), ('heat','warning','{"temp_c":35,"feels_c":33}')
on conflict (kind, grade) do nothing;

insert into alert_settings (kind, repeat_policy, repeat_accum_threshold, heat_repeat_basis) values
 ('rain','until_daily_accum_below',80,null), ('snow','hourly_until_below',null,null),
 ('wind','hourly_until_below',null,null),    ('heat','hourly_until_below',null,'feels')
on conflict (kind) do nothing;

-- 부서 트리 (PPT 조직도). departments에는 이름 유니크 제약이 없어 on conflict를
-- 쓸 수 없다 — 대신 "이미 같은 자리(같은 부모 밑 같은 이름)에 있으면 넣지
-- 않는다"를 where not exists로 직접 구현해 재실행해도 늘어나지 않게 한다.
insert into departments (name, sort_order)
select v.name, v.sort_order
from (values
  ('사업지원',1),('리조트',2),('레포츠 · 화담숲',3),('골프',4)
) as v(name, sort_order)
where not exists (
  select 1 from departments d where d.parent_id is null and d.name = v.name
);

insert into departments (parent_id, name, sort_order)
select r.id, c.name, c.ord
from departments r
join (values
 ('사업지원','안전',1),('사업지원','인프라 운영',2),
 ('리조트','객실',1),('리조트','영업',2),('리조트','식음',3),('리조트','조리',4),
 ('레포츠 · 화담숲','레포츠',1),('레포츠 · 화담숲','화담숲',2),
 ('골프','운영기획',1),('골프','경기',2),('골프','조리',3),('골프','서비스 운영',4)
) as c(root, name, ord) on c.root = r.name
where r.parent_id is null
  and not exists (
    select 1 from departments d2 where d2.parent_id = r.id and d2.name = c.name
  );
