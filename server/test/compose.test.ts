import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// 사내 서버는 무인이다. 윈도우 업데이트나 정전으로 재부팅되면 도커 데몬이 다시
// 뜨면서 restart 정책이 있는 컨테이너만 되살아난다. postgres에 정책이 없던 동안
// (도커 기본값 no) app만 살아나는 상태가 만들어졌다: /api/health는 DB를 건드리지
// 않아 200, `docker compose ps`는 Up (healthy), 그런데 화면의 모든 기능이 500이고
// 워치독은 DB에 못 닿아 예외를 던지며 guarded가 그것을 삼킨다 — 아무에게도
// 알리지 않는다. 정책 한 줄이 지워져도 사람 눈에는 안 보이므로 여기서 고정한다.
const here = dirname(fileURLToPath(import.meta.url));
const compose = readFileSync(join(here, "..", "..", "docker-compose.yml"), "utf8");

/** 서비스 블록별로 `키: 값` 한 쌍을 뽑는다(주석 줄은 건너뛴다). YAML 파서를 새로
 * 들이지 않으려고 최소한으로 훑는다 — 이 파일의 들여쓰기는 2/4칸으로 고정돼 있다. */
function serviceValue(service: string, key: string): string | null {
  const lines = compose.split("\n");
  let inside = false;
  for (const line of lines) {
    const svc = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (svc) {
      inside = svc[1] === service;
      continue;
    }
    if (!inside) continue;
    const kv = new RegExp(`^ {4}${key}:\\s*(.+?)\\s*$`).exec(line);
    if (kv) return kv[1].replace(/^"|"$/g, "");
  }
  return null;
}

describe("docker-compose 재시작 정책", () => {
  it("postgres는 호스트가 재부팅돼도 스스로 되살아난다", () => {
    expect(serviceValue("postgres", "restart")).toBe("unless-stopped");
  });

  it("app도 마찬가지다", () => {
    expect(serviceValue("app", "restart")).toBe("unless-stopped");
  });

  // 끝난 1회성 컨테이너를 계속 되살리면 무한 재기동이 된다.
  it("migrate는 1회성이라 재시작하지 않는다", () => {
    expect(serviceValue("migrate", "restart")).toBe("no");
  });

  // 데이터가 사는 곳이다. 이름 없는 볼륨이 되면 재생성 때 조용히 날아간다.
  it("postgres 데이터는 이름 붙은 볼륨에 남는다", () => {
    expect(compose).toMatch(/- pgdata:\/var\/lib\/postgresql\/data/);
  });
});
