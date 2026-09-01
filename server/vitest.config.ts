import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// 서버 테스트는 실제 Postgres(DATABASE_URL_USER/SERVICE)에 붙는다 — 그 값은
// 이 서버 패키지가 아니라 저장소 루트 .env에 있다(docker-compose.yml과 db/migrations가
// 같은 값을 쓴다). 예전에는 "루트 .env를 export하고 돌려라"가 어디에도 적히지 않아
// 리뷰어가 그냥 npm test를 돌리면 ECONNREFUSED로 전부 실패했다 — 인수인계 문서가
// "npm test 한 줄"로 끝나야 하므로, 여기서 직접 읽어 process.env에 채운다.
//
// 루트 .env에는 `<oauth client id>` 같은 placeholder 값도 있어(아직 안 쓰는 카카오워크
// 필드) `source`/`export`로 읽으면 셸 파싱 에러가 난다 — 셸을 거치지 않고 파일을
// 직접 파싱해 그 문제를 피한다. 이미 설정된 값(CI 등에서 명시적으로 준 값)은
// 덮어쓰지 않는다.
function loadRootEnv() {
  const here = dirname(fileURLToPath(import.meta.url));
  const rootEnvPath = join(here, "..", ".env");
  if (!existsSync(rootEnvPath)) return;
  const text = readFileSync(rootEnvPath, "utf8");
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    if (process.env[key] !== undefined) continue; // 이미 설정된 값을 우선한다
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

loadRootEnv();

export default defineConfig({
  test: {
    // 실제 카카오워크로 나가는 것을 한 곳에서 막는다(test/setup.ts 주석 참고).
    setupFiles: ["./test/setup.ts"],
    // 여러 테스트 파일이 같은 실제 Postgres 컨테이너의 auth_accounts 등을
    // beforeEach에서 지웠다 채운다. 파일을 병렬로 돌리면 한 파일의 삭제가
    // 다른 파일이 방금 만든 행을 지워 버려 조용히 실패한다(주로
    // "Cannot read properties of undefined (reading 'id')" 형태로 나타난다).
    // password-reset.test.ts를 추가하며 이 경합이 실제로 재현됐다.
    fileParallelism: false,
  },
});
