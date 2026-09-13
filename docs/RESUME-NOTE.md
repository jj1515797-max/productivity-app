# 이어서 하기 — MES 핵심 사양서 작업

## 무엇을 만들고 있나
회사용 새 Claude Code 계정으로 옮기기 위해, 이 앱의 **현황(대시보드) + 입력(1·2·3호기, 외포장-1/2/3)**
부분을 그대로 다시 만들 수 있는 **사양서(프롬프트)** 를 쓰는 중.
결과물: `docs/MES-CORE-SPEC.md`

## 진행 상태
- [x] 0부 — 스택·설정·배포 (작성 완료, 아래 파일에 있음)
- [x] 1부 — 앱 뼈대 (작성+검증 완료)
- [x] 2부 — 데이터 모델 (작성 완료, 검증 미실시)
- [x] 4부 — 현황 화면 (작성 완료, 검증 미실시)
- [x] 5부 — 호기 입력 (작성 완료, 검증 미실시)
- [x] 6부 — 외포장 입력 (작성 완료, 검증 미실시)
- [x] 3부 — 현황↔입력 연결 (작성 완료, 검증 미실시) ★
- [x] 7부 — 연결 부속 (작성 완료, 검증 미실시)

## 분석 워크플로
7개 영역을 병렬로 읽고, 각 초안을 코드와 대조 검증하는 워크플로를 돌렸다.
- runId: `wf_bfb618c7-a35`
- script: `/root/.claude/projects/-home-user-productivity-app/2ae6f6f9-7c92-5a7d-b879-0523638e4e63/workflows/scripts/mes-core-spec-wf_bfb618c7-a35.js`
- 결과 journal: 같은 세션 subagents/workflows/wf_bfb618c7-a35/journal.jsonl
- 끊겼으면 `Workflow({scriptPath, resumeFromRunId:'wf_bfb618c7-a35'})` 로 캐시 재사용하며 이어붙인다.

## 읽어야 할 원본 파일 (사양서의 근거)
```
src/App.tsx                      라우팅·네비·셸
src/components/AnalyticsGate.tsx 분석 메뉴 접근 제한
src/lib/viewDate.ts              조회 날짜
src/lib/dateUtil.ts              todayKey 등
src/firebase.ts                  Firebase 초기화
src/types.ts                     데이터 모델
src/lib/codeUtil.ts              제품코드 정규화 (canonicalShort/compareCode)
src/pages/Dashboard.tsx          현황
src/pages/Machine.tsx            1·2·3호기 입력
src/pages/ExternalPack.tsx       외포장 입력
src/pages/Remaining.tsx          잔여량/부족분
src/components/LogisticsInputModal.tsx  잔여량 입력
src/components/AmbientInputModal.tsx    실온 입력
src/components/ProcessTimeline.tsx      공정 타임라인
src/lib/monthlyProduction.ts     ★ 일자 단위 생산량 확정 규칙
src/lib/completionAlert.ts       완료 알림
src/lib/productionNotify.ts      생산 알림
src/lib/presence.ts              접속자 표시
src/lib/dbBackup.ts              백업
```

## 작성 원칙 (다음 세션도 지킬 것)
- 코드를 붙여넣지 않는다. 무엇을·왜·어떤 규칙인지를 글로 쓴다.
- 다만 **Firestore 경로·필드명·계산식·상수·화면 문구**는 정확히 그대로 적는다.
- 놓치기 쉬운 것 우선: 코드 정규화, 반올림 위치, null 처리, 실시간 구독, 날짜 경계, 정렬 tie-break.

---

## 2026-09-13 시점 결과

`docs/MES-CORE-SPEC.md` **작성 완료 (약 19만자, 부록 A 에 놓치기 쉬운 규칙 222건)**.

### 남은 일 — 2~7부 교차검증
7개 영역 초안은 전부 나왔고, **1부만 코드와 대조 검증을 마쳤다**(부록 B).
2~7부 검증 6건은 세션 한도(`You've hit your session limit`)로 실패했다.

이어서 하려면 캐시를 그대로 쓰며 검증만 다시 돌리면 된다:
```
Workflow({
  scriptPath: '/root/.claude/projects/-home-user-productivity-app/2ae6f6f9-7c92-5a7d-b879-0523638e4e63/workflows/scripts/mes-core-spec-wf_bfb618c7-a35.js',
  resumeFromRunId: 'wf_bfb618c7-a35'
})
```
read 단계 7건은 캐시에서 즉시 돌아오고, 실패한 verify 6건만 새로 돈다.

검증 결과가 나오면 부록 B 에 부별로 덧붙인다. **검증 결과가 본문과 충돌하면 검증 쪽이 맞다** —
초안은 코드를 읽고 쓴 것이고 검증은 그 초안을 코드와 한 줄씩 대조한 것이다.

### 초안 원본 (재조립이 필요하면)
`journal.jsonl` 에 에이전트별 반환값이 그대로 남아 있다.
`{type:'started'}` 라인의 `agentId`→`label` 매핑으로 `{type:'result'}` 라인을 짝지으면 된다.
