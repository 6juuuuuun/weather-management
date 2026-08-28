-- 0008_selfhost_auth.sql은 app_user/app_service를 nologin으로 만든다(그 시점엔 역할
-- 자체와 권한만 있으면 됐다). Task 2의 server/src/db.ts는 그 역할로 직접 접속하는데,
-- nologin 역할은 접속 자체가 거부된다 — 뒤늦게 드러난 계획 결함이다.
--
-- 여기서 LOGIN 자격을 얹는다. 0008을 고치지 않고 새 파일로 얹는 이유는 이 스택이 곧
-- 실서버에 올라가기 때문에, 적용된 마이그레이션을 사후에 고치는 습관을 들이지 않기 위해서다.
--
-- 비밀번호는 이 파일에 절대 적지 않는다. psql -v로 전달받은 값을 :'변수' 구문으로만
-- 꽂는다(psql이 SQL 문자열 리터럴로 안전하게 인용해 준다). db/package.json의 migrate
-- 스크립트가 APP_USER_PASSWORD / APP_SERVICE_PASSWORD 환경변수를 -v로 넘긴다.
--
-- superuser로 접속해 SET LOCAL ROLE로 역할만 바꾸는 대안은 쓰지 않는다 — 그 한 문장을
-- 빠뜨리면 RLS가 통째로 우회된 채 조용히 통과하기 때문이다(server/src/db.ts 참고).
-- 대신 접속 자체를 역할별로 분리해 그 실수를 구조적으로 막는다.
begin;

alter role app_user login password :'app_user_pw';
alter role app_service login password :'app_service_pw';

commit;
