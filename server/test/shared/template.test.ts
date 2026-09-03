// 이관 전 원본(supabase/functions/_shared/template_test.ts, git 기록)에서 이관.
import { describe, expect, it } from "vitest";
import { composeDraft, renderMessage, KIND_LABEL, GRADE_LABEL } from "../../src/shared/template.ts";

const G = [{ department_id:"d1", department_name:"객실", kind:"rain", grade:"watch",
  staff_actions:["수건 2개 배포"], guest_notice:"안내문" }];
const R = [{ department_id:"d1", employee_id:"e1", name:"홍수진", phone:"010-1234-5678" }];

describe("발송 템플릿", () => {
  it("composeDraft: 지침 있는 부서만 블록 생성 + 수신자 병합 + selected 기본 true", () => {
    const blocks = composeDraft("rain", "watch", G as any, R as any);
    expect(blocks.length).toBe(1);
    expect(blocks[0]!.recipients[0]!.name).toBe("홍수진");
    expect(blocks[0]!.selected).toBe(true);
  });
  it("renderMessage: 부서·등급·지침·멘트 포함", () => {
    const [b] = composeDraft("rain", "watch", G as any, R as any);
    const msg = renderMessage(b!, { kindLabel: KIND_LABEL.rain, gradeLabel: GRADE_LABEL.watch,
      siteName: "곤지암", obsLine: "시간당 32.5mm" });
    expect(msg).toContain("폭우 주의보");
    expect(msg).toContain("객실");
    expect(msg).toContain("• 수건 2개 배포");
    expect(msg).toContain("안내문");
  });
});
