import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // 여러 테스트 파일이 같은 실제 Postgres 컨테이너의 auth_accounts 등을
    // beforeEach에서 지웠다 채운다. 파일을 병렬로 돌리면 한 파일의 삭제가
    // 다른 파일이 방금 만든 행을 지워 버려 조용히 실패한다(주로
    // "Cannot read properties of undefined (reading 'id')" 형태로 나타난다).
    // password-reset.test.ts를 추가하며 이 경합이 실제로 재현됐다.
    fileParallelism: false,
  },
});
