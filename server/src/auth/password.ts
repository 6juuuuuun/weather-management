import argon2 from "argon2";
import { randomBytes } from "node:crypto";

/** 해싱은 직접 만들지 않는다. argon2 기본 설정을 그대로 쓴다. */
export function hash(plain: string): Promise<string> {
  return argon2.hash(plain);
}

export async function verify(storedHash: string, plain: string): Promise<boolean> {
  try {
    return await argon2.verify(storedHash, plain);
  } catch {
    // 해시 형식이 깨져 있어도 예외 대신 실패로 취급한다
    return false;
  }
}

/** 관리자가 발급하는 임시 비밀번호. 사람이 옮겨 적을 수 있는 길이로 만든다. */
export function temporaryPassword(): string {
  return randomBytes(9).toString("base64url");
}
