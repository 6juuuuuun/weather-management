import { assertEquals, assertStringIncludes } from "jsr:@std/assert";
import { composeDraft, renderMessage, KIND_LABEL, GRADE_LABEL } from "./template.ts";

const G = [{ department_id:"d1", department_name:"객실", kind:"rain", grade:"watch",
  staff_actions:["수건 2개 배포"], guest_notice:"안내문" }];
const R = [{ department_id:"d1", employee_id:"e1", name:"홍수진", kakaowork_user_id:"kw1" }];

Deno.test("composeDraft: 지침 있는 부서만 블록 생성 + 수신자 병합 + selected 기본 true", () => {
  const blocks = composeDraft("rain", "watch", G as any, R as any);
  assertEquals(blocks.length, 1);
  assertEquals(blocks[0].recipients[0].name, "홍수진");
  assertEquals(blocks[0].selected, true);
});
Deno.test("renderMessage: 부서·등급·지침·멘트 포함", () => {
  const [b] = composeDraft("rain", "watch", G as any, R as any);
  const msg = renderMessage(b, { kindLabel: KIND_LABEL.rain, gradeLabel: GRADE_LABEL.watch,
    siteName: "곤지암", obsLine: "시간당 32.5mm" });
  assertStringIncludes(msg, "폭우 주의보");
  assertStringIncludes(msg, "객실");
  assertStringIncludes(msg, "• 수건 2개 배포");
  assertStringIncludes(msg, "안내문");
});
