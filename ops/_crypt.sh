# 백업 암호화 공통 조각. backup.sh · restore.sh · verify-backup.sh 가 함께 읽는다.
#
# **왜 필요한가:** 백업은 "서버 밖(NAS·외장하드)에 두라"고 안내한다 — 서버가 통째로
# 죽는 상황이 바로 백업을 꺼내 쓰는 상황이기 때문이다. 그런데 그렇게 밖으로 나간
# 파일에는 직원 이름·이메일·휴대폰번호가 **평문으로** 들어 있다. gzip은 압축이지
# 암호화가 아니다. 파일 하나만 있으면 누구든 열어 볼 수 있다.
#
# **무엇을 막고 무엇은 못 막는가:** 열쇠(BACKUP_PASSPHRASE)는 서버의 .env에 있다.
# 서버가 통째로 뚫리면 열쇠도 함께 털리므로, 이것이 막는 것은 **파일이 서버 밖으로
# 나갔을 때**다 — USB 분실, NAS 접근 권한 실수, 잘못 보낸 메일. 백업을 밖에 두라고
# 안내하는 이상 그 경로가 가장 현실적인 유출 경로이고, 그래서 여기를 먼저 막는다.
#
# 켜는 법: .env 에 BACKUP_PASSPHRASE 한 줄. 없으면 예전처럼 평문으로 만든다
# (이미 돌고 있는 설치를 갑자기 깨뜨리지 않는다). 있으면 파일 이름이
# weather-….sql.gz.enc 가 되고, 복구·검사 스크립트가 확장자를 보고 알아서 푼다.
#
# 도구는 openssl이다. gpg가 아니라 openssl인 이유는 **어디에나 있기 때문**이다 —
# 우분투 기본 설치에 들어 있고 맥에도 있다. 백업을 푸는 일은 대개 급할 때
# 생기는데, 그때 "gpg를 먼저 설치하세요"가 되면 안 된다.

# .env에서 값 하나를 읽는다. 값에 = 가 들어 있어도 첫 = 뒤 전부를 가져온다.
crypt_env_get() {
  [ -f .env ] || return 0
  sed -n "s/^$1=//p" .env | head -1
}

BACKUP_PASSPHRASE="${BACKUP_PASSPHRASE:-$(crypt_env_get BACKUP_PASSPHRASE)}"

crypt_enabled() { [ -n "${BACKUP_PASSPHRASE:-}" ]; }

crypt_require_tool() {
  command -v openssl >/dev/null 2>&1 && return 0
  echo "백업 암호화를 켰는데 openssl이 없습니다." >&2
  echo "  설치: sudo apt-get install -y openssl" >&2
  echo "  또는 .env의 BACKUP_PASSPHRASE 줄을 지우면 예전처럼 평문으로 만듭니다." >&2
  exit 1
}

# 반복 횟수. 암호화할 때와 풀 때가 **같아야** 한다 — 다르면 비밀번호가 맞아도
# 풀리지 않는다. 그래서 상수 하나를 양쪽이 함께 쓴다.
CRYPT_ITER=200000

# 암호를 명령줄에 두지 않는다 — ps 로 다른 사용자에게 보인다.
# 0600 임시 파일로 건네고 곧바로 지운다.
_crypt_pass_file() {
  f="$(mktemp)"; chmod 600 "$f"; printf '%s' "$BACKUP_PASSPHRASE" > "$f"; printf '%s' "$f"
}

# 평문 gz 파일 → 암호화 파일. 성공하면 원본을 지운다.
crypt_encrypt_file() { # $1=입력(gz)  $2=출력(gz.enc)
  crypt_require_tool
  pf="$(_crypt_pass_file)"
  if ! openssl enc -aes-256-cbc -pbkdf2 -iter "$CRYPT_ITER" -salt \
        -pass "file:$pf" -in "$1" -out "$2" 2>/dev/null; then
    rm -f "$pf"; return 1
  fi
  rm -f "$pf"; rm -f "$1"
}

# 백업 파일의 **gz 바이트**를 표준출력으로 흘린다. 확장자가 .gpg면 풀어서 낸다.
# 세 스크립트가 파일을 읽는 자리는 전부 이 함수를 지난다 — 암호화 여부를
# 신경 쓰는 곳이 한 군데뿐이어야 한쪽만 고쳐지는 일이 없다.
crypt_stream() { # $1=백업 파일
  case "$1" in
    *.enc)
      crypt_require_tool
      if [ -z "${BACKUP_PASSPHRASE:-}" ]; then
        echo "암호화된 백업인데 BACKUP_PASSPHRASE가 없습니다: $1" >&2
        echo "  이 파일을 만든 서버의 .env에 있던 값이 필요합니다." >&2
        echo "  그 값을 잃어버리면 이 백업은 영영 열 수 없습니다." >&2
        exit 1
      fi
      pf="$(_crypt_pass_file)"
      openssl enc -d -aes-256-cbc -pbkdf2 -iter "$CRYPT_ITER" \
        -pass "file:$pf" -in "$1" 2>/dev/null || {
        rm -f "$pf"
        echo "백업을 풀지 못했습니다: $1" >&2
        echo "  BACKUP_PASSPHRASE가 이 파일을 만들 때와 다르거나 파일이 손상됐습니다." >&2
        exit 1
      }
      rm -f "$pf"
      ;;
    *) cat "$1" ;;
  esac
}
