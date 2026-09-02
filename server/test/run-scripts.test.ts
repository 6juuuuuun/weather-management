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
  return [...line.matchAll(/"(--[^"]+)"/g)].map((m) => m[1]!);
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

// QA W-23(g) · `ops/make-admin.sh`는 **관리자 0명 상태를 푸는 유일한 절차**다.
// 그런데 스택을 기본 이름이 아닌 compose 프로젝트로 올리면(`-p`/`COMPOSE_PROJECT_NAME`)
// `docker compose exec`가 서비스를 찾지 못하고 도커 원문("service \"postgres\" is not
// running")만 나왔다. 검증에서 실제로 이렇게 막혔고, 그 문장은 "그런 직원이 없습니다"도
// 아니라 처음 설치하는 사람은 **가입이 잘못된 줄 알고 가입을 계속 다시 한다.**
// 스크립트를 여기서 실행해 볼 수는 없으므로(도커가 필요하다) 계약을 파일 내용으로 묶는다.
describe("ops/make-admin.sh가 막히는 이유를 사람 말로 알려 준다 (W-23g)", () => {
  const script = readFileSync(join(here, "..", "..", "ops", "make-admin.sh"), "utf8");

  it("postgres 컨테이너를 못 찾으면 도커 원문 대신 안내를 낸다", () => {
    expect(script).toContain("docker compose ps -q postgres");
    expect(script).toMatch(/postgres\) 컨테이너를 찾지 못했습니다/);
  });

  it("다른 compose 프로젝트 이름을 쓰는 법을 그 자리에서 알려 준다", () => {
    expect(script).toContain("COMPOSE_PROJECT_NAME=");
    expect(script).toContain("docker compose ls");
  });

  it("운영 안내서 §1-5도 같은 탈출구를 적는다", () => {
    const manual = readFileSync(join(here, "..", "..", "docs", "운영.md"), "utf8");
    expect(manual).toContain("COMPOSE_PROJECT_NAME=프로젝트이름 ./ops/make-admin.sh");
    // 가입을 다시 하는 것이 해법이라고 오해하지 않게 못박는다.
    expect(manual).toMatch(/가입을 다시 할 필요는\n?없습니다/);
  });
});
