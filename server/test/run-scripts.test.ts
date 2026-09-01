import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// server/package.json의 dev·start와 server/Dockerfile의 CMD는 같은 코드를 같은
// node로 띄운다. 그런데 한동안 서로 달랐다: Dockerfile은
// --experimental-transform-types(파라미터 프로퍼티가 있는 src/shared/kakaowork.ts를
// 위해 반드시 필요하다)로 고쳐졌는데 package.json 스크립트는
// --experimental-strip-types로 남아, `npm start`가 ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX로
// 아예 뜨지 않았다. 배포는 도커만 쓰니 막히지 않았고, 그래서 아무도 몰랐다.
//
// 두 곳을 실제로 대조해 다시 갈라지면 실패하게 만든다. 로컬 node로 직접 띄워
// 확인하지 않는 이유: 이 플래그는 node 22(=배포 이미지)의 것이고 개발자 PC의
// node 버전은 제각각이라 실행 결과가 환경마다 달라진다. 계약은 "두 곳이 같다"이다.
const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8"));
const dockerfile = readFileSync(join(here, "..", "Dockerfile"), "utf8");

/** `CMD ["node", "--experimental-transform-types", "src/index.ts"]`에서 플래그만 뽑는다. */
function dockerNodeFlags(): string[] {
  const line = dockerfile.split("\n").find((l) => l.trimStart().startsWith("CMD"));
  if (!line) throw new Error("Dockerfile에 CMD가 없습니다");
  return [...line.matchAll(/"(--[^"]+)"/g)].map((m) => m[1]);
}

function scriptNodeFlags(script: string): string[] {
  return script.split(/\s+/).filter((t) => t.startsWith("--") && t !== "--watch");
}

describe("npm 스크립트가 실제로 서버를 띄울 수 있다", () => {
  it("Dockerfile CMD는 타입 변환 플래그를 쓴다", () => {
    expect(dockerNodeFlags()).toContain("--experimental-transform-types");
  });

  for (const name of ["start", "dev"]) {
    it(`npm run ${name}의 node 플래그가 Dockerfile CMD와 같다`, () => {
      expect(scriptNodeFlags(pkg.scripts[name])).toEqual(dockerNodeFlags());
    });
  }

  // strip-only 모드로는 src/shared/kakaowork.ts의 파라미터 프로퍼티를 못 읽어
  // 서버가 뜨지 않는다. 그 플래그가 다시 들어오면 바로 잡는다.
  for (const name of ["start", "dev"]) {
    it(`npm run ${name}이 strip-only 모드를 쓰지 않는다`, () => {
      expect(pkg.scripts[name]).not.toContain("--experimental-strip-types");
    });
  }
});
