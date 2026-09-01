/// <reference types="node" />
// no-forbidden-copy.test.ts와 같은 이유로 이 파일만 node: 내장 모듈을 쓴다.
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// lib/types.ts의 테이블 타입 10개가 참조 0건인 죽은 코드로 남아 있었다
// (lib/api/{dashboard,org,content}.ts가 같은 모양을 …Row로 다시 정의했기 때문이다).
// 죽은 정의는 쓸모없는 데서 끝나지 않고 살아 있는 쪽과 조용히 어긋난다: 살아남은
// Employee에는 phone·account_status가 없는데 EmployeeRow에는 있었고, AuthProvider가
// EmployeeRow를 Employee 타입 필드에 담고 있어(구조적 서브타입이라 통과)
// useAuth().employee로는 그 두 필드에 접근할 수 없었다.
//
// 타입이 죽었다는 사실은 테스트도 타입체커도 잡아 주지 않는다 — 그래서 여기서 센다.
const SKIP_DIRS = new Set(["node_modules", "dist", "build", ".git"]);
const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = join(__dirname, "..", ".."); // apps/web/src
const TYPES_FILE = join(SRC_ROOT, "lib", "types.ts");

function listFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) files.push(...listFiles(full));
    else if (/\.(ts|tsx)$/.test(entry)) files.push(full);
  }
  return files;
}

const exported = [...readFileSync(TYPES_FILE, "utf8").matchAll(/^export type (\w+)/gm)].map((m) => m[1]);
const others = listFiles(SRC_ROOT)
  .filter((f) => f !== TYPES_FILE)
  .map((f) => readFileSync(f, "utf8"))
  .join("\n");

describe("lib/types.ts", () => {
  it("내보내는 타입이 실제로 쓰인다 (죽은 타입 금지)", () => {
    expect(exported.length).toBeGreaterThan(0);
    const dead = exported.filter((name) => !new RegExp(`\\b${name}\\b`).test(others));
    expect(dead).toEqual([]);
  });

  // Employee를 두 벌로 적어 두면 한쪽만 필드가 늘어나 위와 같은 드리프트가 되살아난다.
  // lib/api/org.ts는 모양을 다시 적지 않고 이 타입을 그대로 재사용해야 한다.
  it("lib/api/org.ts의 EmployeeRow는 Employee를 그대로 재사용한다", () => {
    const org = readFileSync(join(SRC_ROOT, "lib", "api", "org.ts"), "utf8");
    expect(org).toMatch(/export type EmployeeRow = Employee;/);
  });
});
