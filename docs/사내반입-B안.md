# B안 — 서버가 밖으로 못 나갈 때 반입하는 법

[`서버-설치-체크리스트.md`](서버-설치-체크리스트.md) §2의 외부 통신 검사에서
`000`이 나왔을 때 여기로 옵니다. §4(코드 받기)를 이 문서로 대신하고,
§5(설치 스크립트)부터는 그대로 이어서 하면 됩니다.

## 먼저: 무엇이 막혔는지에 따라 길이 갈립니다

§2의 세 줄 결과를 봅니다.

| github | dockerhub · npm | 가는 길 |
|---|---|---|
| ❌ | ✅ | **B-1** — 코드만 넣으면 서버가 알아서 빌드합니다 |
| ❌ | ❌ | **B-2** — 이미지까지 통째로 넣습니다 |
| ✅ | ✅ | B안이 필요 없습니다. 체크리스트 §4로 돌아가세요 |

확인 명령(서버에서):

```bash
for h in github.com registry-1.docker.io registry.npmjs.org; do
  printf "%-24s " "$h"
  curl -s -m 8 -o /dev/null -w "%{http_code}\n" "https://$h" || echo 000
done
```

`000`이면 막힌 것입니다.

---

## B-1 — 코드만 반입 (서버가 빌드)

### 왜 Gitea를 거치나

USB로 한 번 넣고 끝나는 일이 아닙니다. 앞으로 코드를 고칠 때마다 반복해야 하는데,
사내 Gitea에 한 번 올려 두면 그 뒤로는 서버에서 `git pull` 한 줄입니다.
**Gitea가 사내망의 GitHub 역할을 합니다.**

### ① 개발 담당자(사외망 PC)에서 — 저장소를 파일 하나로 만든다

```bash
cd ~/orca/Weather
git bundle create ~/weather-transfer/weather-main.bundle main
```

`weather-main.bundle` 하나에 **전체 이력이 들어 있습니다**(약 4.5MB).
USB·사내 메신저·메일 등 반입이 허용된 수단으로 옮깁니다.

### ② 사내 PC에서 — Gitea에 올린다

Gitea 웹에서 빈 저장소 `weather-management`를 먼저 만듭니다(README 생성은 체크 해제).

```bash
git clone weather-main.bundle weather-management
cd weather-management
git remote remove origin
git remote add origin http://<Gitea주소>/<계정>/weather-management.git
git push -u origin main
```

### ③ 서버에서 — Gitea에서 받는다

```bash
git clone http://<Gitea주소>/<계정>/weather-management.git ~/weather
cd ~/weather && ls ops/install.sh && git log --oneline -1
```

여기까지 되면 [체크리스트 §5](서버-설치-체크리스트.md)로 이어집니다.

### 다음부터 코드 갱신

```
사외망 PC   git bundle create …           (바뀐 것만 담고 싶으면 아래 참고)
사내 PC     git pull bundle → git push origin main
서버        cd ~/weather && git pull && ./ops/install.sh
```

이미 한 번 올린 뒤에는 **바뀐 부분만** 담아 파일을 작게 만들 수 있습니다.
`main`이 마지막으로 반입된 커밋을 `<지난커밋>`이라 하면:

```bash
git bundle create ~/weather-transfer/weather-update.bundle <지난커밋>..main
```

---

## B-2 — 완전 오프라인 (이미지까지 반입)

서버가 Docker Hub·npm 어디에도 못 나갈 때입니다. 이 경우 **서버는 빌드하지
않습니다** — 이미 만들어진 이미지를 받아서 실행만 합니다.

### ⚠️ 먼저 서버의 CPU 종류를 확인하세요

```bash
uname -m
```

- `x86_64` → 아래 `--platform linux/amd64` 그대로
- `aarch64` → `linux/arm64`로 바꿉니다

**이것을 틀리면 이미지가 서버에서 아예 실행되지 않습니다.** 개발용 맥은 arm64라
기본 빌드 결과가 서버(대개 x86_64)와 맞지 않습니다. 반드시 지정해야 합니다.

### ① 사외망 PC에서 — 이미지 두 개를 파일로 만든다

```bash
cd ~/orca/Weather

# 우리 앱 (서버 CPU에 맞춰 빌드)
docker buildx build --platform linux/amd64 \
  -f server/Dockerfile -t weather-app:offline --load .

# 데이터베이스 (공식 이미지를 그대로)
docker pull --platform linux/amd64 postgres:16-alpine

mkdir -p ~/weather-transfer
docker save weather-app:offline postgres:16-alpine \
  | gzip > ~/weather-transfer/weather-images.tar.gz
```

`weather-images.tar.gz`는 대략 **400~600MB**입니다. 코드 번들(§B-1 ①)도 함께 옮깁니다.
두 파일이 필요합니다.

> 맥에서 `--platform linux/amd64` 빌드는 에뮬레이션이라 **10~20분** 걸립니다. 정상입니다.

### ② 서버에서 — 이미지를 불러온다

```bash
gunzip -c weather-images.tar.gz | docker load
docker images | grep -E "weather-app|postgres"
```

두 줄이 보이면 성공입니다.

### ③ 서버에서 — 빌드하지 않고 그 이미지를 쓰게 한다

`~/weather`에 코드를 넣은 뒤(§B-1 ①~③ 또는 번들 직접 clone),
`docker-compose.override.yml`을 **새로 만듭니다**:

```yaml
# 반입한 이미지를 그대로 쓴다. build 절을 덮어써서 서버가 빌드하지 않게 한다.
services:
  app:
    image: weather-app:offline
    build: !reset null
    pull_policy: never
  postgres:
    pull_policy: never
  migrate:
    pull_policy: never
```

`build: !reset null`이 동작하지 않는 옛 Compose라면, 그 줄 대신
`docker compose up -d`를 **`--build` 없이** 실행하면 됩니다 — 이미지가 이미 있으면
Compose는 다시 만들지 않습니다.

이후 [체크리스트 §5](서버-설치-체크리스트.md)의 `./ops/install.sh`를 실행합니다.
스크립트가 포트·이름 충돌을 확인하고 `.env`를 만들어 줍니다.

### 다음부터 코드 갱신

코드만 바뀌었으면 ①을 다시 하고 ②③을 반복합니다. 매번 400MB를 옮기는 것이
부담이면, **서버가 npm·Docker Hub에만 나갈 수 있는지** 다시 확인해 보세요 —
그 둘만 열리면 B-1로 내려올 수 있고, 그때부터는 코드 번들(수 MB)만 옮기면 됩니다.

---

## 이미 다른 서비스가 떠 있는 서버에서 (중요)

이 서버에는 이미 두 개의 서비스가 돌고 있습니다. `ops/install.sh`가 다음을
**알아서** 처리합니다.

- **컨테이너 이름 겹침** — 다른 폴더의 컨테이너와 이름이 겹치면 멈추고,
  `.env`에 `COMPOSE_PROJECT_NAME=weather2`를 넣으라고 알려 줍니다.
  **남의 컨테이너를 건드리지 않습니다.**
- **포트 겹침** — 8080·5433이 쓰이고 있으면 빈 포트를 찾아 `.env`에 적습니다.
  임직원 접속 주소가 `http://서버IP:8090`처럼 바뀔 수 있습니다.

### 프로젝트 이름은 반드시 고정하세요

`.env`에 이 한 줄을 넣어 두는 것을 권합니다:

```
COMPOSE_PROJECT_NAME=weather
```

Docker Compose는 이름을 주지 않으면 **폴더 이름에서 만들어 내는데, 버전에 따라
하이픈 처리가 달라집니다**(`weather-trial` → `weathertrial` 또는 `weather-trial`).
개발 중에 실제로 이 일이 일어나, Compose가 **빈 볼륨으로 새 스택을 만들려 해
데이터가 갈라질 뻔했습니다.** 이름을 고정하면 그 위험이 사라집니다.

---

## 반입 전 확인 (개발 담당자)

- [ ] 번들이 온전한가: `git bundle verify weather-main.bundle`
- [ ] `.env`가 번들에 없는가: `git ls-files | grep -c '^\.env$'` → **0**
      (비밀값은 반입 파일에 들어가지 않습니다)
- [ ] B-2라면 서버 CPU(`uname -m`)와 빌드 `--platform`이 같은가
