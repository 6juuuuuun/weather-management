#!/usr/bin/env bash
# 날씨경영을 사내 서버에 처음 올리거나, 올려 둔 것을 다시 점검·기동한다.
#
#   cd ~/weather && ./ops/install.sh
#
# 이 한 줄이 순서대로 다음을 한다. 각 단계는 사람이 손으로 하면 빠뜨리기 쉬운 것들이다.
#   1) Docker가 있고 이 계정으로 쓸 수 있는지
#   2) 디스크 여유
#   3) 이미 떠 있는 다른 컨테이너와 이름이 겹치지 않는지 (기존 컨테이너는 건드리지 않는다)
#   4) 8080·5433 포트가 비어 있는지 — 쓰고 있으면 빈 포트를 골라 .env에 적는다
#   5) .env가 없으면 만들고(비밀번호 자동 생성), 있으면 빈칸이 남았는지 검사
#   6) 서버가 기상청·npm·Docker Hub에 나갈 수 있는지
#   7) docker compose up -d --build
#   8) 앱이 healthy가 될 때까지 기다린 뒤 /api/health/deep 결과를 보여 준다
#
# 몇 번을 다시 돌려도 안전하다. 이미 있는 .env와 데이터는 덮어쓰지 않는다.
#
# 묻는 값(기상청 키·접속 주소·이메일 도메인)은 환경변수로 미리 주면 묻지 않는다:
#   KMA_API_KEY=... APP_BASE_URL=http://10.58.209.4:8080 ./ops/install.sh
#
# 서버에 직접 붙을 수 없는 개발 담당자가 운영자에게 "이 스크립트를 돌리고 출력을
# 통째로 보내 달라"고 하기 위해 만들었다. 그래서 출력이 길고 친절하다.
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"
ENV_FILE="$ROOT/.env"
TEMPLATE="$ROOT/.env.selfhost.example"

# ---------- 출력 도우미 ----------
step() { printf '\n\033[1m[%s/8] %s\033[0m\n' "$1" "$2"; }
ok()   { printf '  ✔ %s\n' "$*"; }
warn() { printf '  ⚠ %s\n' "$*"; }
info() { printf '    %s\n' "$*"; }
die() {
  printf '\n  ✘ %s\n' "$1" >&2
  shift
  for line in "$@"; do printf '    %s\n' "$line" >&2; done
  printf '\n  여기서 멈춥니다. 위 내용을 그대로 개발 담당자에게 전달하세요.\n' >&2
  exit 1
}

# 터미널에서 직접 돌리는지(질문 가능) 판단한다. 크론이나 파이프에서는 묻지 않는다.
INTERACTIVE=0
[ -t 0 ] && [ -t 1 ] && INTERACTIVE=1

# ask 변수명 "질문" "기본값" — 환경변수로 이미 주어졌으면 묻지 않는다.
ask() {
  local var="$1" prompt="$2" default="${3:-}" cur
  cur="${!var:-}"
  if [ -n "$cur" ]; then return 0; fi
  if [ "$INTERACTIVE" = "0" ]; then
    [ -n "$default" ] && { printf -v "$var" '%s' "$default"; return 0; }
    die "$var 값이 필요한데 터미널이 아니라 물을 수 없습니다." \
        "환경변수로 주세요: $var=값 ./ops/install.sh"
  fi
  if [ -n "$default" ]; then
    read -r -p "  $prompt [$default]: " cur </dev/tty
    cur="${cur:-$default}"
  else
    while [ -z "$cur" ]; do read -r -p "  $prompt: " cur </dev/tty; done
  fi
  printf -v "$var" '%s' "$cur"
}

# ---------- .env 읽기/쓰기 ----------
env_get() { # KEY → 값 (없으면 빈 문자열)
  [ -f "$ENV_FILE" ] || return 0
  grep -E "^${1}=" "$ENV_FILE" | tail -1 | cut -d= -f2- || true
}
env_set() { # KEY VALUE — 있으면(주석 처리된 줄 포함) 바꾸고, 없으면 끝에 붙인다
  local key="$1" val="$2"
  if grep -Eq "^#?[[:space:]]*${key}=" "$ENV_FILE"; then
    awk -v k="$key" -v v="$val" '
      BEGIN { done = 0 }
      !done && $0 ~ "^#?[[:space:]]*" k "=" { print k "=" v; done = 1; next }
      { print }
    ' "$ENV_FILE" > "$ENV_FILE.tmp"
    mv "$ENV_FILE.tmp" "$ENV_FILE"
  else
    printf '%s=%s\n' "$key" "$val" >> "$ENV_FILE"
  fi
}

# ---------- 포트 ----------
port_in_use() { # 포트 번호 → 0이면 사용 중
  local p="$1"
  # 1) 다른 컨테이너가 이미 호스트 포트로 내보내고 있는가. ss로만 보면 놓치는 경우가
  #    있다(docker의 userland-proxy가 꺼져 있으면 iptables로만 잡혀 listen 소켓이 없다).
  if docker ps --format '{{.Ports}}' 2>/dev/null | tr ',' '\n' | grep -Eq "[:.]${p}->"; then
    return 0
  fi
  # 2) 호스트의 listen 소켓 (리눅스)
  if command -v ss >/dev/null 2>&1; then
    ss -ltn 2>/dev/null | awk 'NR>1 {print $4}' | grep -Eq "[:.]${p}\$" && return 0
  fi
  # 3) 직접 붙어 본다(bash 내장 /dev/tcp). ss가 없는 환경(macOS 등)의 마지막 수단.
  if (exec 3<>"/dev/tcp/127.0.0.1/${p}") 2>/dev/null; then
    exec 3>&- 2>/dev/null || true
    return 0
  fi
  return 1
}
pick_free_port() { # 시작 포트 → 비어 있는 첫 포트
  local p="$1" end=$(( $1 + 50 ))
  while [ "$p" -le "$end" ]; do
    port_in_use "$p" || { echo "$p"; return 0; }
    p=$((p + 1))
  done
  return 1
}

# ---------- compose 프로젝트 이름 ----------
# compose는 폴더 이름을 프로젝트 이름으로 쓰고 컨테이너를 <프로젝트>-app-1 처럼 짓는다.
# 서버에 다른 프로젝트가 같은 이름으로 떠 있으면 서로 덮어쓴다. 그래서 먼저 본다.
PROJECT="${COMPOSE_PROJECT_NAME:-$(env_get COMPOSE_PROJECT_NAME)}"
if [ -z "$PROJECT" ]; then
  PROJECT="$(basename "$ROOT" | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9_-')"
  [ -n "$PROJECT" ] || PROJECT=weather
fi
export COMPOSE_PROJECT_NAME="$PROJECT"

# 우리 스택의 컨테이너가 지금 돌고 있는가 (재실행 판정용)
ours_running() { # 서비스명
  local id
  id="$(docker compose ps -q "$1" 2>/dev/null || true)"
  [ -n "$id" ] && [ "$(docker inspect -f '{{.State.Running}}' "$id" 2>/dev/null)" = "true" ]
}

echo "날씨경영 설치 · $(date '+%Y-%m-%d %H:%M:%S') · $(hostname) · $ROOT"
echo "compose 프로젝트 이름: $PROJECT"

# =====================================================================
step 1 "Docker 확인"
command -v docker >/dev/null 2>&1 || die "docker 명령이 없습니다." \
  "설치:  curl -fsSL https://get.docker.com | sudo sh" \
  "설치 후:  sudo usermod -aG docker \$USER  → 로그아웃하고 다시 로그인 → 이 스크립트 재실행"
docker compose version >/dev/null 2>&1 || die "docker compose(v2)가 없습니다." \
  "설치:  sudo apt-get install -y docker-compose-plugin   (Ubuntu/Debian)" \
  "확인:  docker compose version"
if ! docker info >/dev/null 2>&1; then
  if sudo -n docker info >/dev/null 2>&1; then
    die "이 계정($USER)은 docker를 쓸 권한이 없습니다(root만 가능)." \
        "아래 한 줄을 실행하고, 반드시 로그아웃 후 다시 로그인한 뒤 재실행하세요:" \
        "  sudo usermod -aG docker $USER"
  fi
  die "docker 데몬에 연결할 수 없습니다." \
      "확인:  sudo systemctl status docker" \
      "기동:  sudo systemctl enable --now docker"
fi
ok "docker $(docker version -f '{{.Server.Version}}' 2>/dev/null) · compose $(docker compose version --short 2>/dev/null)"
if command -v systemctl >/dev/null 2>&1; then
  if systemctl is-enabled docker >/dev/null 2>&1; then
    ok "docker 서비스가 부팅 시 자동 시작으로 설정돼 있습니다"
  else
    warn "docker가 부팅 시 자동 시작되지 않습니다. 재부팅 뒤 서비스가 내려간 채로 남습니다."
    info "해결:  sudo systemctl enable docker"
  fi
fi

# =====================================================================
step 2 "디스크 여유"
free_gb=$(df -Pk "$ROOT" | awk 'NR==2 {printf "%d", $4/1024/1024}')
docker_root=$(docker info -f '{{.DockerRootDir}}' 2>/dev/null || echo /var/lib/docker)
docker_free_gb=$(df -Pk "$docker_root" 2>/dev/null | awk 'NR==2 {printf "%d", $4/1024/1024}' || echo "$free_gb")
info "저장소 폴더: ${free_gb}GB 남음 · 도커 데이터($docker_root): ${docker_free_gb}GB 남음"
if [ "${docker_free_gb:-0}" -lt 5 ]; then
  die "도커 데이터 디스크 여유가 5GB 미만입니다. 이미지 빌드가 실패하거나 DB가 멈춥니다." \
      "정리:  docker system df   →   docker image prune -a   (다른 서비스 담당자와 상의 후)"
elif [ "${docker_free_gb:-0}" -lt 20 ]; then
  warn "여유가 20GB 미만입니다. 백업까지 두려면 부족할 수 있습니다."
else
  ok "충분합니다"
fi

# =====================================================================
step 3 "이미 떠 있는 컨테이너 (건드리지 않습니다)"
existing="$(docker ps --format '{{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}' 2>/dev/null || true)"
if [ -n "$existing" ]; then
  printf '    %-28s %-32s %-22s %s\n' NAME IMAGE STATUS PORTS
  while IFS=$'\t' read -r n i s p; do printf '    %-28s %-32s %-22s %s\n' "$n" "$i" "$s" "$p"; done <<<"$existing"
else
  info "실행 중인 컨테이너가 없습니다"
fi
for svc in app postgres; do
  cname="${PROJECT}-${svc}-1"
  if docker inspect "$cname" >/dev/null 2>&1; then
    wd="$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project.working_dir"}}' "$cname")"
    if [ "$wd" != "$ROOT" ]; then
      die "이름이 겹치는 컨테이너가 이미 있습니다: $cname (다른 폴더 $wd 의 것)" \
          "그 컨테이너를 덮어쓰지 않기 위해 멈춥니다. 우리 쪽 이름을 바꾸세요:" \
          "  echo COMPOSE_PROJECT_NAME=weather2 >> .env   → 재실행"
    fi
  fi
done
ok "이름 충돌 없음"

# =====================================================================
step 4 "포트"
APP_PORT="$(env_get APP_HOST_PORT)"; APP_PORT="${APP_PORT:-8080}"
PG_PORT="$(env_get POSTGRES_HOST_PORT)"; PG_PORT="${PG_PORT:-5433}"
port_note=""
if ours_running app; then
  ok "웹 포트 $APP_PORT — 이미 우리 app이 쓰고 있습니다(재실행)"
elif port_in_use "$APP_PORT"; then
  new_port="$(pick_free_port "$APP_PORT")" || die "8080 근처에 빈 포트가 없습니다."
  warn "웹 포트 $APP_PORT 은(는) 다른 프로그램이 쓰고 있습니다 → $new_port 을(를) 대신 씁니다"
  APP_PORT="$new_port"; port_note="APP_HOST_PORT=$APP_PORT"
else
  ok "웹 포트 $APP_PORT 비어 있음"
fi
if ours_running postgres; then
  ok "DB 포트 $PG_PORT — 이미 우리 postgres가 쓰고 있습니다(재실행)"
elif port_in_use "$PG_PORT"; then
  new_pg="$(pick_free_port "$PG_PORT")" || die "5433 근처에 빈 포트가 없습니다."
  warn "DB 포트 $PG_PORT 은(는) 사용 중 → $new_pg 을(를) 대신 씁니다 (127.0.0.1 전용이라 외부 노출은 없습니다)"
  PG_PORT="$new_pg"; port_note="$port_note POSTGRES_HOST_PORT=$PG_PORT"
else
  ok "DB 포트 $PG_PORT 비어 있음 (127.0.0.1 전용)"
fi

# =====================================================================
step 5 "설정 파일 .env"
server_ip="$(hostname -I 2>/dev/null | awk '{print $1}' || true)"
[ -n "$server_ip" ] || server_ip="$(hostname)"

if [ ! -f "$ENV_FILE" ]; then
  [ -f "$TEMPLATE" ] || die "템플릿 $TEMPLATE 이 없습니다. 저장소가 온전한지 확인하세요."
  command -v openssl >/dev/null 2>&1 || die "openssl이 없어 비밀번호를 만들 수 없습니다." "설치:  sudo apt-get install -y openssl"
  info "처음 설치입니다. 몇 가지만 묻겠습니다 (Enter는 [ ] 안의 기본값)."
  echo
  ask KMA_API_KEY "기상청 공공데이터포털 인증키(Decoding)"
  ask APP_BASE_URL "임직원이 접속할 주소" "http://${server_ip}:${APP_PORT}"
  ask ALLOWED_EMAIL_DOMAINS "가입을 허용할 이메일 도메인(콤마 구분)" "gonjiam.com"
  echo

  cp "$TEMPLATE" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  pg_pw="$(openssl rand -hex 24)"
  env_set POSTGRES_PASSWORD "$pg_pw"
  env_set APP_USER_PASSWORD "$(openssl rand -hex 24)"
  env_set APP_SERVICE_PASSWORD "$(openssl rand -hex 24)"
  env_set DATABASE_URL "postgres://postgres:${pg_pw}@127.0.0.1:${PG_PORT}/weather"
  env_set KMA_API_KEY "$KMA_API_KEY"
  env_set APP_BASE_URL "$APP_BASE_URL"
  env_set ALLOWED_EMAIL_DOMAINS "$ALLOWED_EMAIL_DOMAINS"
  env_set COMPOSE_PROJECT_NAME "$PROJECT"
  # 백업 암호화 비밀번호도 여기서 만든다. 사람이 나중에 "보안 조치"로 켜기를
  # 기다리면 대개 안 켜지고, 그 사이 백업 파일이 평문으로 서버 밖에 쌓인다.
  env_set BACKUP_PASSPHRASE "$(openssl rand -hex 24)"
  ok ".env 를 만들었습니다 (비밀번호 4개 자동 생성, 권한 600)"
  warn "이 파일이 사라지면 데이터베이스에 다시 접속할 수 없고, **백업도 열 수 없습니다.**"
  warn "안전한 곳에 한 부 복사해 두세요 (비밀번호 관리도구 권장)."
else
  ok ".env 가 이미 있습니다 — 덮어쓰지 않고 검사만 합니다"
fi

# 포트가 바뀌었으면 기록한다 (재실행 때는 기존 값 그대로).
[ "$APP_PORT" != "8080" ] && env_set APP_HOST_PORT "$APP_PORT"
if [ "$PG_PORT" != "5433" ]; then
  env_set POSTGRES_HOST_PORT "$PG_PORT"
  # 호스트용 psql 접속 문자열도 같은 포트를 가리키게 맞춘다.
  cur_url="$(env_get DATABASE_URL)"
  env_set DATABASE_URL "$(printf '%s' "$cur_url" | sed -E "s#@127\.0\.0\.1:[0-9]+/#@127.0.0.1:${PG_PORT}/#")"
fi
[ -n "$port_note" ] && info ".env 에 기록: $port_note"

# 빈칸·자리표시자 검사
bad=""
for key in POSTGRES_PASSWORD APP_USER_PASSWORD APP_SERVICE_PASSWORD KMA_API_KEY APP_BASE_URL ALLOWED_EMAIL_DOMAINS; do
  v="$(env_get "$key")"
  case "$v" in
    ""|*여기에_*|*공공데이터포털_*|*사내주소*|*"<"*) bad="$bad $key" ;;
  esac
done
[ -z "$bad" ] || die ".env 에 아직 채우지 않은 값이 있습니다:$bad" \
  "편집:  nano .env   (없으면 vi .env)" \
  "비밀번호는 openssl rand -hex 24 로 만듭니다. 채운 뒤 재실행하세요."
for key in POSTGRES_PASSWORD APP_USER_PASSWORD APP_SERVICE_PASSWORD; do
  v="$(env_get "$key")"
  [[ "$v" =~ ^[A-Za-z0-9]+$ ]] || warn "$key 에 영문·숫자 외 문자가 있습니다. 접속 주소가 깨질 수 있습니다."
done
base_url="$(env_get APP_BASE_URL)"
cookie_secure="$(env_get COOKIE_SECURE)"
if [[ "$base_url" == http://* ]] && [ "$cookie_secure" = "true" ]; then
  warn "접속 주소가 http 인데 COOKIE_SECURE=true 입니다 → 로그인이 아예 되지 않으므로 false 로 고칩니다"
  env_set COOKIE_SECURE false
fi
ok "필수 값 모두 채워짐 · 접속 주소 $base_url"

# =====================================================================
step 6 "외부 통신"
probe() { # 이름 URL → HTTP 코드(000이면 불가)
  curl -sS -o /dev/null -m 8 -w '%{http_code}' "$2" 2>/dev/null || echo 000
}
if command -v curl >/dev/null 2>&1; then
  kma="$(probe kma https://apis.data.go.kr/)"
  npm="$(probe npm https://registry.npmjs.org/)"
  hub="$(probe hub https://registry-1.docker.io/v2/)"
  if [ "$kma" = "000" ]; then
    warn "apis.data.go.kr 에 닿지 않습니다 → 기상청 수집이 통째로 멈춥니다. 서버 담당자에게 아웃바운드 443 허용을 요청하세요."
    info "(설치는 계속합니다. 화면은 뜨지만 관측값이 들어오지 않습니다.)"
  else
    ok "기상청 apis.data.go.kr 도달 (HTTP $kma)"
  fi
  have_image="$(docker image ls -q "${PROJECT}-app" 2>/dev/null || true)"
  if [ "$npm" = "000" ] || [ "$hub" = "000" ]; then
    if [ -n "$have_image" ]; then
      warn "npm/Docker Hub 에 닿지 않지만 이미 빌드된 이미지가 있어 그대로 진행합니다 (코드 업데이트는 반영되지 않을 수 있음)"
    else
      die "npm(HTTP $npm) 또는 Docker Hub(HTTP $hub)에 닿지 않아 이미지를 빌드할 수 없습니다." \
          "이 서버는 폐쇄망입니다. 개발 담당자에게 알려 '이미지 파일 반입(B안)' 절차로 진행하세요." \
          "(docs/배포-준비-체크리스트.md '폐쇄망일 때')"
    fi
  else
    ok "npm(HTTP $npm) · Docker Hub(HTTP $hub) 도달"
  fi
else
  warn "curl 이 없어 외부 통신을 미리 확인하지 못했습니다. 빌드에서 실패하면 폐쇄망을 의심하세요."
fi

# =====================================================================
step 7 "올리기 — docker compose up -d --build (처음은 5~15분)"
set +e
docker compose up -d --build
rc=$?
set -e
if [ "$rc" != "0" ]; then
  echo
  echo "  ---- migrate 로그(마지막 40줄) ----"
  docker compose logs --no-color --tail 40 migrate 2>/dev/null || true
  echo "  ---- app 로그(마지막 40줄) ----"
  docker compose logs --no-color --tail 40 app 2>/dev/null || true
  die "docker compose up 이 실패했습니다(종료 코드 $rc)." \
      "위 로그를 그대로 개발 담당자에게 보내세요. (docs/운영.md §7 참고)"
fi
ok "컨테이너를 올렸습니다"

# =====================================================================
step 8 "상태 확인"
app_id="$(docker compose ps -q app 2>/dev/null || true)"
[ -n "$app_id" ] || die "app 컨테이너가 보이지 않습니다." "확인:  docker compose ps -a"
printf '  앱이 준비되기를 기다립니다'
for i in $(seq 1 60); do
  st="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$app_id" 2>/dev/null || echo unknown)"
  [ "$st" = "healthy" ] && break
  if [ "$st" = "exited" ] || [ "$st" = "dead" ]; then
    echo
    docker compose logs --no-color --tail 40 app 2>/dev/null || true
    die "app 컨테이너가 종료됐습니다." "위 로그를 개발 담당자에게 보내세요. (docs/운영.md §7-1)"
  fi
  printf '.'; sleep 3
done
echo
docker compose ps
if [ "$st" != "healthy" ]; then
  docker compose logs --no-color --tail 40 app 2>/dev/null || true
  die "3분이 지나도 app 이 healthy 가 되지 않았습니다(상태: $st)." "위 로그를 개발 담당자에게 보내세요."
fi
ok "app · postgres 모두 healthy"

# healthy 는 "웹 서버가 응답한다"는 뜻일 뿐이다. 스키마가 실제로 들어갔는지는 따로 본다.
# migrate 가 아무 일도 하지 않고 0으로 끝나는 경우가 실제로 있었다(마운트가 빈 폴더로
# 잡혀 스크립트가 통째로 비어 있던 경우). 그때도 컨테이너는 전부 healthy 였고
# 화면은 떴다 — 로그인부터 전부 500 이었을 뿐이다.
mig_count="$(docker compose exec -T postgres psql -U postgres -d weather -tAqc "select count(*) from schema_migrations" 2>/dev/null | tr -d '[:space:]' || true)"
roles_ok="$(docker compose exec -T postgres psql -U postgres -d weather -tAqc "select count(*) from pg_roles where rolname in ('app_user','app_service') and rolcanlogin" 2>/dev/null | tr -d '[:space:]' || true)"
if [ -z "$mig_count" ] || [ "$mig_count" = "0" ] || [ "$roles_ok" != "2" ]; then
  echo
  echo "  ---- migrate 로그 ----"
  docker compose logs --no-color --tail 40 migrate 2>/dev/null || true
  die "데이터베이스 스키마가 적용되지 않았습니다 (schema_migrations=${mig_count:-없음}, 로그인 가능한 앱 계정=${roles_ok:-0}/2)." \
      "컨테이너는 떠 있지만 화면의 모든 기능이 실패하는 상태입니다. 위 migrate 로그와 함께 개발 담당자에게 보내세요." \
      "(docs/운영.md §7-2)"
fi
ok "데이터베이스 스키마 적용됨 (마이그레이션 ${mig_count}건 기록, 앱 계정 2개)"

if command -v curl >/dev/null 2>&1; then
  echo
  echo "  /api/health/deep 응답:"
  deep_body="$(curl -sS -m 10 -w '\n%{http_code}' "http://127.0.0.1:${APP_PORT}/api/health/deep" 2>/dev/null || printf '\n000')"
  deep_code="${deep_body##*$'\n'}"
  deep_body="${deep_body%$'\n'*}"
  printf '    %s\n' "$deep_body"
  echo
  # reasons 배열의 항목 수 = 따옴표로 닫힌 문자열 사이의 "," 개수 + 1
  reasons="$(printf '%s' "$deep_body" | sed -n 's/.*"reasons":\[\(.*\)\].*/\1/p')"
  n_reasons=0
  if [ -n "$reasons" ]; then n_reasons=$(( $(printf '%s' "$reasons" | grep -o '","' | wc -l | tr -d ' ') + 1 )); fi
  case "$deep_code" in
    200) ok "심층 점검 200 — 모든 항목 정상" ;;
    503)
      if [ "$n_reasons" = "1" ] && printf '%s' "$reasons" | grep -q "SMS 발송 설정"; then
        ok "사유가 'SMS 발송 설정이 아직 없습니다' 하나뿐 → 문자 연동을 빼면 준비가 끝난 상태입니다 (지금 단계의 정상)"
      elif printf '%s' "$reasons" | grep -q "데이터베이스"; then
        die "심층 점검이 데이터베이스 문제를 보고합니다: $reasons" "위 내용을 개발 담당자에게 보내세요. (docs/운영.md §7-4)"
      else
        warn "사유 ${n_reasons}건. 'SMS 발송 설정' 외의 사유(관측 지점 없음, 행동지침 없음 등)는 관리자가 화면의 셋업 체크리스트에서 채우면 풀립니다."
      fi ;;
    *)   warn "심층 점검 응답이 예상과 다릅니다(HTTP $deep_code). 개발 담당자에게 알려 주세요." ;;
  esac
fi

# =====================================================================
cat <<EOF

========================================================================
  설치 완료

  화면 주소     : $base_url
                  (같은 망의 PC 브라우저에서 열립니다. 서버 IP: $server_ip, 포트: $APP_PORT)

  다음에 할 일  (docs/운영.md 1-5, 1-6, 4-1, 4-2)
    1) 브라우저에서 위 주소로 들어가 회사 이메일로 가입
    2) 첫 관리자 지정:   cd $ROOT && ./ops/make-admin.sh 본인이메일@회사도메인
    3) 다시 로그인 → 대시보드의 셋업 체크리스트를 순서대로 (관측 지점 → 행동지침 → 수신자)
    4) 백업 폴더 만들고 한 번 떠 보기:
         sudo mkdir -p /backup/weather && sudo chown "\$USER" /backup/weather
         BACKUP_DIR=/backup/weather ./ops/backup.sh
    5) 매일 새벽 자동 백업(crontab -e) — 운영.md 4-2 의 두 줄

  개발 담당자에게 보낼 것: 이 출력 전체(위에서부터) 를 복사해서 전달
========================================================================
EOF
