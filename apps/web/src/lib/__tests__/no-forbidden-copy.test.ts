/// <reference types="node" />
// 이 파일만 node: 내장 모듈을 쓴다(Vitest는 Node에서 실행되므로 사용 가능) —
// tsconfig.app.json은 "types": ["vite/client"]만 자동 포함하므로, 이 파일에서만
// 명시적으로 @types/node를 끌어와 tsc 전체 설정을 건드리지 않는다.
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

// 이 브랜치에서 '사업부장' 문구 4곳이 승인 권한 모델과 어긋난 채 남아 있다가
// 수동 grep으로만 발견됐다(lib/roles.ts는 이미 별도 테스트로 고정돼 있지만,
// 그 테스트는 lib/roles.ts만 보고 화면 문구는 보지 않는다). 같은 실수가
// 다시 조용히 재발하지 않도록 apps/web/src 전체를 스캔한다.

const SKIP_DIRS = new Set(["node_modules", "dist", "build", ".git"]);
const FORBIDDEN = "사업부장";

// 의도적으로 남겨둔 곳: roles.ts의 설명 주석, 그 사실을 고정하는 roles.test.ts,
// 그리고 이 파일 자신(금지어를 검사하려면 금지어 문자열을 코드에 담아야 한다).
const ALLOWED_FILES = new Set([
  "lib/roles.ts",
  "lib/__tests__/roles.test.ts",
  "lib/__tests__/no-forbidden-copy.test.ts",
]);

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = join(__dirname, "..", ".."); // apps/web/src

function listFiles(dir: string): string[] {
  const entries = readdirSync(dir);
  const files: string[] = [];
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      files.push(...listFiles(fullPath));
    } else if (/\.(ts|tsx|js|jsx)$/.test(entry)) {
      files.push(fullPath);
    }
  }
  return files;
}

describe("금지 문구: 사업부장", () => {
  it(`apps/web/src 어디에도 '${FORBIDDEN}'이 없다 (의도된 두 곳 제외)`, () => {
    const offenders: string[] = [];
    for (const filePath of listFiles(SRC_ROOT)) {
      const relPath = relative(SRC_ROOT, filePath).split("\\").join("/");
      if (ALLOWED_FILES.has(relPath)) continue;
      const lines = readFileSync(filePath, "utf-8").split("\n");
      lines.forEach((line, idx) => {
        if (line.includes(FORBIDDEN)) {
          offenders.push(`${relPath}:${idx + 1}: ${line.trim()}`);
        }
      });
    }
    expect(
      offenders,
      offenders.length > 0
        ? `'${FORBIDDEN}' 문구가 다음 위치에 남아 있다 (허용된 곳은 lib/roles.ts와 lib/__tests__/roles.test.ts뿐):\n` +
          offenders.join("\n")
        : undefined,
    ).toEqual([]);
  });
});
