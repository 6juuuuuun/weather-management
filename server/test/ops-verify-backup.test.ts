import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { execFile } from "node:child_process";
import { gzipSync } from "node:zlib";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// ops/*.sh에는 자동 테스트가 하나도 없어서, 백업 검사가 조용히 약해져도 아무도
// 모른다 — 실제로 "크기만 보는" 검사가 그렇게 통과했고, 사람이 손으로 덤프를
// 끊어 봐야만 드러났다. verify-backup.sh는 파일 내용만 보므로 Postgres도 도커도
// 없이 그대로 태울 수 있다. 여기서 그 판정을 고정한다.
//
// 이 테스트가 지키는 것은 "무엇을 거부해야 하는가"다. 세 겹(gzip 온전성 /
// 완료 표지 / 필수 테이블) 중 어느 하나를 빼도 여기서 실패한다.

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(here, "..", "..", "ops", "verify-backup.sh");

function run(args: string[]): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile("/bin/sh", [SCRIPT, ...args], (err, stdout, stderr) => {
      resolve({
        code: err && typeof (err as { code?: number }).code === "number" ? (err as { code: number }).code : 0,
        out: `${stdout}${stderr}`,
      });
    });
  });
}

// pg_dump가 만드는 파일의 뼈대만 흉내 낸다. 스크립트가 보는 것은 완료 표지와
// COPY 절뿐이라 이것으로 충분하다.
const TRAILER = "--\n-- PostgreSQL database dump complete\n--\n";
function dumpText(tables: string[], withTrailer = true): string {
  const body = tables
    .map((t) => `COPY public.${t} (id) FROM stdin;\n1\n\\.\n\n`)
    .join("");
  return `--\n-- PostgreSQL database dump\n--\n\n${body}${withTrailer ? TRAILER : ""}`;
}

const ALL = ["action_guidelines", "departments", "employees", "weather_criteria", "weather_observations"];

let dir = "";
const p = (name: string) => join(dir, name);

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "weather-verify-"));
  writeFileSync(p("good.sql.gz"), gzipSync(Buffer.from(dumpText(ALL))));
  // 덤프가 중간에 끊긴 파일: gzip 자체는 멀쩡하고 크기도 충분한데 완료 표지가
  // 없고 뒤쪽 테이블이 빠져 있다. 크기 검사만 하던 시절이 통과시키던 바로 그 모양.
  writeFileSync(
    p("cut-dump.sql.gz"),
    gzipSync(Buffer.from(dumpText(["action_guidelines", "alert_settings"], false))),
  );
  // 완료 표지는 있는데 테이블이 빠진 파일(표지만 보는 검사를 잡는다)
  writeFileSync(p("no-table.sql.gz"), gzipSync(Buffer.from(dumpText(["action_guidelines"]))));
  // gzip 자체가 잘린 파일
  const whole = gzipSync(Buffer.from(dumpText(ALL)));
  writeFileSync(p("cut-raw.sql.gz"), whole.subarray(0, Math.floor(whole.length / 2)));
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("ops/verify-backup.sh", () => {
  it("온전한 덤프는 통과시킨다", async () => {
    const r = await run([p("good.sql.gz")]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("쓸 수 있는 백업입니다");
  });

  // 이 파일이 통과하면 "복구했더니 DB가 비었다"가 된다. 라운드 1의 반려 사유다.
  it("완료 표지가 없는 덤프는 거부한다", async () => {
    const r = await run([p("cut-dump.sql.gz")]);
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/끊겼습니다/);
  });

  it("필수 테이블이 빠지면 거부한다", async () => {
    const r = await run([p("no-table.sql.gz")]);
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/테이블이 빠졌습니다/);
    // 무엇이 빠졌는지 이름을 알려 줘야 운영자가 판단할 수 있다.
    expect(r.out).toMatch(/employees/);
  });

  it("gzip이 손상된 파일은 거부한다", async () => {
    const r = await run([p("cut-raw.sql.gz")]);
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/손상/);
  });

  it("없는 파일은 거부한다", async () => {
    const r = await run([p("nope.sql.gz")]);
    expect(r.code).not.toBe(0);
  });

  it("파일 경로를 안 주면 거부한다", async () => {
    const r = await run([]);
    expect(r.code).not.toBe(0);
  });
});
