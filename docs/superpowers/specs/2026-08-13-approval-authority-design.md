# 승인 권한 단일화 — 설계 문서

- 날짜: 2026-08-13
- 상태: 설계 승인 완료 (사용자 승인 2026-08-13)
- 관련: `docs/superpowers/specs/2026-08-12-weather-management-design.md` (결정 8 갱신)

## 1. 문제

승인 권한의 출처가 두 곳으로 갈라져 있고, 서로 연결되어 있지 않다.

- **UI가 말하는 것**: `Criteria.tsx:296` — "특보 Alert 수신자 … 특보 감지 시 초안 검토 요청을 받는 **승인 권한자**입니다"
- **코드가 보는 것**: `employees.role = 'approver'`

`alert_recipients`는 역할 제약이 없어(`Criteria.tsx:216`의 후보 필터에 role 조건 없음) 누구든 등록되고, 칩에 역할까지 표시하면서 그대로 받아들인다. 그러나 이 설정은 **DM 발송 대상만 정할 뿐 어떤 권한도 부여하지 않는다.**

### 실제 발생한 증상 (2026-08-13 운영)

관리자(`admin`)가 UI 문구를 그대로 읽고 본인을 Alert 수신자로 등록했다. 결과:

1. 특보 감지 시 "승인을 기다립니다 + 검토 링크" DM은 정상 수신
2. 링크로 `/events/:id` 진입 가능
3. 그러나 `EventReview.tsx:387`의 `canEdit`이 `role === 'approver'`를 요구해 **편집·승인 버튼이 렌더되지 않음**
4. `Dashboard.tsx:251`도 같은 조건이라 승인 대기 배너의 CTA가 안 보임
5. 우회 호출해도 `send/index.ts:67`이 403

그리고 운영 DB에 `role = 'approver'`인 직원이 **0명**이다. 즉 특보가 떠도 승인할 수 있는 사람이 존재하지 않으며, 초기 설정 체크리스트(`lib/setup.ts`)는 5개 항목을 모두 통과시켜 **정상으로 보인다.**

승인 요청을 받는 사람이 승인할 수 없는 상태는 어떤 설정으로도 정당화되지 않는다.

## 2. 결정

**승인 권한의 출처를 `alert_recipients` 하나로 통일한다.**

근거:

- UI가 이미 그렇게 약속하고 있고, 사용자의 멘탈모델도 그렇다.
- "승인 요청을 받는 사람"과 "승인할 수 있는 사람"은 정의상 같아야 한다.
- 원 스펙 결정 8의 "사업부장"은 **직급 예시**이지 권한 모델이 아니다(2026-08-13 사용자 확인). 실제 의도는 "Alert 수신자 자리에 사업부장을 앉힌다"였다.

이 결정으로 스펙 결정 8을 다음과 같이 갱신한다:

> 8. 권한 — 화면 접근은 3역할(`admin`/`approver`/`staff`)로 나누되, **승인·발송 권한은 역할이 아니라 `alert_recipients` 등록 여부가 결정한다.**

## 3. 변경 범위

세 계층이 모두 같은 질문으로 바뀐다 — *"이 사람이 Alert 수신자인가?"*

| # | 위치 | 현재 | 변경 후 |
|---|------|------|---------|
| 1 | `send/index.ts:67` (승인 게이트) | `emp.role !== 'approver'` → 403 | `alert_recipients` 미등록 → 403 |
| 2 | `0002_rls.sql:56` (`w_approver` on `messages`) | `current_emp_role() = 'approver'` | `current_emp_is_approver()` |
| 3 | `Dashboard.tsx:251`, `EventReview.tsx:387` | `employee?.role === 'approver'` | Alert 수신자 여부 |

### 3.1 DB 헬퍼

기존 `current_emp_id()` / `current_emp_role()`과 동일한 패턴으로 추가한다. 새 패턴이 아니다.

```sql
create function current_emp_is_approver() returns boolean
language sql stable security definer set search_path = public as
$$ select exists (select 1 from alert_recipients where employee_id = current_emp_id()) $$;
```

`security definer`가 필요한 이유는 기존 두 헬퍼와 같다 — 정책 평가 중 `employees`/`alert_recipients`를 조회해야 하는데 그 조회 자체가 RLS에 걸리면 순환한다.

### 3.2 프런트엔드

승인 권한은 현재 로그인 사용자가 `alert_recipients`에 있는지로 판정한다. `alert_recipients`는 `r_all` 정책으로 로그인 사용자 전체가 읽을 수 있으므로 클라이언트에서 조회 가능하다.

권한 판정을 화면마다 반복하지 않도록 단일 지점에 둔다 — 기존 `employee` 컨텍스트에 `isApprover` 를 함께 실어 `Dashboard`/`EventReview`가 같은 값을 쓴다. 서버가 최종 게이트이므로 클라이언트 판정은 노출 제어용이다.

### 3.3 부서 미지정 승인자 접근

`routes.tsx`에서 `/events/:id`는 `requireDepartment`를 요구한다. 다만 `RequireRole`의 실제 조건은 `role === 'staff' && department_id === null`이므로 **막히는 것은 부서 미지정 `staff`뿐이다** — `admin`/`approver`는 부서가 없어도 통과한다.

승인은 부서 단위 업무가 아니라 전사 판단이므로, **Alert 수신자는 부서 미지정 `staff`여도 `/events/:id`에 접근할 수 있어야 한다.** `RequireRole`의 부서 게이트에 "Alert 수신자면 통과" 예외를 추가한다.

## 4. 부수 효과

### 4.1 체크리스트가 의미를 되찾는다

`lib/setup.ts`의 5번 항목 "Alert 수신자 ≥ 1"이 이제 **"승인 가능한 사람이 최소 1명 있다"**를 뜻하게 된다. 항목을 추가할 필요가 없다. 승인자 0명 상태는 자동으로 "초기 설정 미완료"로 표시된다.

### 4.2 `approver` 역할의 잔여 의미

승인이 분리된 뒤 `role = 'approver'`가 실제로 하는 일은 두 가지뿐이다.

- `r_guidelines` RLS: 전 부서 지침 열람 (staff는 자기 부서만)
- `routes.tsx`: `/settings`, `/employees` 조회 접근 (편집은 `isAdmin` 별도 게이트)

즉 **"전 부서를 볼 수 있는 관리급"**이다. enum 이름(`approver`)과 하는 일이 어긋나지만, enum 변경은 마이그레이션·RLS·화면이 연쇄로 딸려오므로 이번 범위에서 제외한다. 대신 **UI 라벨만 `사업부장` → `부서장`으로 바꾼다**(`사업부장`은 직급 예시일 뿐이며 승인과 무관해졌으므로 오해를 남긴다).

라벨 정의가 4곳에 중복되어 있다(`GlobalNav.tsx:8`, `Employees.tsx:14`, `Guidelines.tsx:18`, `Criteria.tsx:26`). 이번에 `lib/`의 단일 상수로 합친다 — 4곳을 각각 고치면 다음에 또 어긋난다.

## 5. 엣지 케이스

| 상황 | 동작 |
|------|------|
| Alert 수신자가 0명 | 체크리스트가 "초기 설정 미완료"로 경고. 특보 감지 시 초안은 생성되나 승인자가 없어 발송 보류 |
| 승인 대기 중 승인자가 명단에서 제거됨 | 남은 다른 수신자가 승인. 명단이 비면 위와 동일 |
| `staff`가 Alert 수신자로 지정됨 | 승인 가능. 관리자가 명시적으로 등록한 것이므로 의도된 동작 |
| Alert 수신자가 부서 미지정 | `/events/:id` 접근 허용 (3.3) |
| 카카오워크 미연결자가 Alert 수신자 | DM은 미도달하나 웹에서는 승인 가능. 별도 이슈(A′ 트랙)로 다룬다 |

## 6. 테스트

- **RLS**: Alert 수신자는 `messages` UPDATE 성공, 비수신자는 거부 (역할과 무관하게)
- **Edge Function**: `send` approve 모드 — 수신자 200, 비수신자 403
- **회귀**: `role = 'approver'`이지만 Alert 수신자가 **아닌** 사람은 승인 불가 (권한 출처가 실제로 바뀌었음을 증명)
- **회귀**: `role = 'admin'`이면서 Alert 수신자인 사람은 승인 가능 (이번에 발생한 증상의 직접 재현)
- **프런트**: 부서 미지정 Alert 수신자가 `/events/:id`에 진입 가능
- **체크리스트**: Alert 수신자 0명일 때 미완료로 계산됨

## 7. 범위 밖

- `emp_role` enum 자체의 개명 (4.2)
- 카카오워크 미연결자 문제 및 명부 선등록 (A′ 트랙, 별도 스펙)
- 승인 이력·감사 로그
