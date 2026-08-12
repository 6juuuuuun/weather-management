insert into site_settings (id) values (1) on conflict do nothing;

insert into weather_criteria (kind, grade, threshold) values
 ('rain','watch','{"rain_mm_per_hr":20}'), ('rain','warning','{"rain_mm_per_hr":50}'),
 ('snow','watch','{"snow_cm":5}'),         ('snow','warning','{"snow_cm":20}'),
 ('wind','watch','{"wind_ms":14}'),        ('wind','warning','{"wind_ms":21}'),
 ('heat','watch','{"temp_c":33,"feels_c":31}'), ('heat','warning','{"temp_c":35,"feels_c":33}');

insert into alert_settings (kind, repeat_policy, repeat_accum_threshold, heat_repeat_basis) values
 ('rain','until_daily_accum_below',80,null), ('snow','hourly_until_below',null,null),
 ('wind','hourly_until_below',null,null),    ('heat','hourly_until_below',null,'feels');

-- 부서 트리 (PPT 조직도)
with roots as (
  insert into departments (name, sort_order) values
   ('사업지원',1),('리조트',2),('레포츠 · 화담숲',3),('골프',4)
  returning id, name
)
insert into departments (parent_id, name, sort_order)
select r.id, c.name, c.ord from roots r
join (values
 ('사업지원','안전',1),('사업지원','인프라 운영',2),
 ('리조트','객실',1),('리조트','영업',2),('리조트','식음',3),('리조트','조리',4),
 ('레포츠 · 화담숲','레포츠',1),('레포츠 · 화담숲','화담숲',2),
 ('골프','운영기획',1),('골프','경기',2),('골프','조리',3),('골프','서비스 운영',4)
) as c(root, name, ord) on c.root = r.name;

-- 예시 지침 (곤지암 목업 — 객실/조리/안전 × 폭우 주의보)
insert into action_guidelines (department_id, kind, grade, staff_actions, guest_notice)
select d.id, 'rain', 'watch', a.actions, a.notice from departments d
join (values
 ('객실', array['비에 젖은 고객을 위해 객실 별 추가 수건 2개 배포','고객 지연 도착에 대비하여 체크인 혼잡 예상 시간 인력 추가 투입'],
  '안녕하세요, 곤지암리조트입니다. 오늘 호우 예보로 야외 시설 운영이 제한됩니다. 실내 편의시설은 정상 운영 중입니다.'),
 ('조리', array['외부 음식 구매가 어려워짐에 따라 내부 식사 인원 증가 예상, 전처리 식자재 점검','우천 시 배송 지연 대비 당일 필수 식자재 우선 발주'], ''),
 ('안전', array['옥외 배수로 및 맨홀 점검, 침수 취약 구역 안전선 설치','우천 시 미끄럼 주의 안내판 주요 동선 배치'], '')
) as a(dept, actions, notice) on d.name = a.dept;
