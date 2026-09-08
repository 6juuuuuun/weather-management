#!/bin/sh
# 데이터베이스를 파일 하나로 통째로 저장한다. 매일 새벽에 자동으로 돌린다
# (docs/운영.md의 "자동 백업 걸기" 참고).
#
# 백업 파일은 서버 안이 아니라 서버 밖(다른 디스크·NAS·외장하드)에 두어야 한다.
# 서버가 통째로 죽는 상황이 바로 백업을 꺼내 쓰는 상황이기 때문이다.
#
#   BACKUP_DIR=/backup/weather ./ops/backup.sh
#
# 비밀번호는 이 파일에 적지 않는다 — postgres 컨테이너 안에서 로컬 소켓으로
# 접속하므로 애초에 필요하지 않다.
set -eu

: "${BACKUP_DIR:?BACKUP_DIR를 지정하세요 (예: BACKUP_DIR=/backup/weather ./ops/backup.sh)}"
[ -d "$BACKUP_DIR" ] || { echo "백업 폴더가 없습니다: $BACKUP_DIR" >&2; exit 1; }

# 저장소 루트에서 실행한다 — docker compose가 docker-compose.yml을 찾아야 한다.
cd "$(dirname "$0")/.."
HERE="$(pwd)"
. "$HERE/ops/_crypt.sh"

# 초까지 넣는다. 분 단위였을 때는 같은 분에 두 번 돌리면 앞 파일이 조용히
# 덮였다(크론은 하루 1회라 실무 영향은 작지만, 손으로 두 번 돌리는 일은 흔하다).
STAMP=$(date +%Y%m%d-%H%M%S)
OUT="$BACKUP_DIR/weather-${STAMP}.sql.gz"
# 임시 이름에 PID를 넣어 두 실행이 겹쳐도 서로의 임시 파일을 지우지 않게 한다.
# 이름은 weather-...sql.gz 로 시작해야 아래 30일 정리 글롭에 걸린다.
TMP="$OUT.$$.partial"
RC="$TMP.rc"

cleanup() { rm -f "$TMP" "$TMP.enc" "$RC"; }

# 신호로 끊겨도(서버 재부팅, docker stop, 운영자의 Ctrl+C) 임시 파일을 남기지 않는다.
# trap이 없던 동안에는 수십 MB짜리 .partial이 백업 디스크에 계속 쌓였다 — 정리
# 글롭이 .partial을 안 잡아서 영원히 지워지지 않았고, 그게 바로 정리 코드가
# 막으려던 "디스크가 차서 어느 날 DB가 멈춘다"였다.
trap 'cleanup; exit 130' INT
trap 'cleanup; exit 143' TERM
trap 'cleanup; exit 129' HUP
trap cleanup EXIT

# 전원이 끊기거나 SIGKILL이면 trap도 못 돈다. 그때 남은 찌꺼기를 다음 백업이
# 치운다. 하루가 지난 것만 지우므로 지금 돌고 있는 다른 백업은 건드리지 않는다.
find "$BACKUP_DIR" -name 'weather-*.partial' -mmin +1440 -delete 2>/dev/null || true
find "$BACKUP_DIR" -name 'weather-*.partial.rc' -mmin +1440 -delete 2>/dev/null || true

# 실패한 덤프가 정상 백업처럼 남으면, 그것이 가짜라는 사실은 복구가 필요한
# 바로 그 순간에 밝혀진다. 백업이 아예 없는 것보다 나쁘다 — 없으면 운영자가
# 자기가 위험한 줄이라도 안다. 그래서 임시 이름(.partial)으로 받고, 아래
# 세 겹의 검사를 전부 통과했을 때만 정상 이름으로 옮긴다.
#
# 예전에는 "파일 크기가 1000바이트를 넘는가"만 봤다. 중요한 실패는 전부
# "헤더 뒤에 한참 쓰다가 끊기는" 모양이라 그 검사는 무력했다 — 뒤쪽 테이블
# (employees, departments …)이 통째로 빠진 9.8MB 파일이 그대로 통과했다.

# --- 1겹: pg_dump의 진짜 종료 코드 ---
# POSIX sh에는 pipefail이 없어서 파이프 왼쪽의 실패가 파이프라인 종료 코드에
# 반영되지 않는다. 종료 코드를 파일로 건네받아 직접 확인한다.
# errexit를 잠깐 끄는 이유: 켜져 있으면 pg_dump가 실패하는 순간 서브셸이
# 그 자리에서 끝나 echo "$?"까지 가지 못한다.
set +e
{ docker compose exec -T postgres pg_dump -U postgres --clean --if-exists weather; echo "$?" > "$RC"; } \
  | gzip > "$TMP"
GZIP_RC=$?
set -e

DUMP_RC=$(cat "$RC" 2>/dev/null || echo 1)
if [ "$DUMP_RC" != "0" ]; then
  cleanup
  echo "백업 실패: pg_dump가 오류로 끝났습니다(종료 코드 $DUMP_RC)." >&2
  echo "  컨테이너 상태와 디스크 여유 공간을 확인하세요: docker compose ps / df -h" >&2
  exit 1
fi
if [ "$GZIP_RC" != "0" ]; then
  cleanup
  echo "백업 실패: 파일을 쓰지 못했습니다(gzip 종료 코드 $GZIP_RC). 디스크가 찼는지 확인하세요." >&2
  exit 1
fi
rm -f "$RC"

# --- 2겹·3겹: 완결성(완료 표지)과 필수 테이블 ---
# 종료 코드만 믿지 않는다. 파일에 실제로 무엇이 담겼는지까지 본다.
if ! "$HERE/ops/verify-backup.sh" "$TMP" >/dev/null 2>&1; then
  echo "백업 실패: 만들어진 파일이 온전하지 않습니다." >&2
  "$HERE/ops/verify-backup.sh" "$TMP" >&2 || true
  cleanup
  exit 1
fi

# 검사를 전부 통과한 뒤에 암호화한다 — 검사는 평문 gz를 읽어야 하고,
# 암호화가 실패하면 백업이 없는 것으로 끝나야 한다(반쯤 된 파일을 남기지 않는다).
if crypt_enabled; then
  OUT="$OUT.enc"
  if ! crypt_encrypt_file "$TMP" "$TMP.enc"; then
    rm -f "$TMP.enc"
    echo "백업 실패: 암호화에 실패했습니다(gpg)." >&2
    cleanup
    exit 1
  fi
  TMP="$TMP.enc"
fi

mv "$TMP" "$OUT"

# 30일이 지난 백업은 지운다. 안 지우면 디스크가 차서 어느 날 DB가 멈춘다.
# 이 줄은 위 검사를 전부 통과한 뒤에만 닿는다 — 오늘 백업이 실패했는데
# 멀쩡한 예전 백업을 지워 버리면 안 된다.
# 글롭 끝의 *는 남아 있을 수 있는 .partial 찌꺼기까지 덮는다(위 trap이 못 돈 경우).
find "$BACKUP_DIR" -name 'weather-*.sql.gz*' -mtime +30 -delete

SIZE=$(wc -c < "$OUT" | tr -d ' ')
echo "백업 완료(검사 통과): $OUT (${SIZE}바이트)"
