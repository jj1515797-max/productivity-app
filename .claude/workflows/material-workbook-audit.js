export const meta = {
  name: 'material-workbook-audit',
  description: '원재료비 수식 엑셀 생성기 전면 검토 — 수식/데이터/분석정의/Excel호환/엣지케이스',
  phases: [
    { title: 'Review', detail: '5개 관점으로 병렬 검토' },
    { title: 'Verify', detail: '각 지적사항을 반박 시도로 검증' },
    { title: 'Synthesize', detail: '확정 결함을 심각도순 정리' },
  ],
};

const FINDINGS = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          file: { type: 'string' },
          line: { type: 'string', description: '줄번호 또는 식별 가능한 코드 조각' },
          severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
          detail: { type: 'string', description: '무엇이 왜 틀렸는지' },
          scenario: { type: 'string', description: '구체적 입력 → 잘못된 출력' },
          fix: { type: 'string', description: '제안 수정' },
        },
        required: ['title', 'file', 'severity', 'detail', 'scenario', 'fix'],
      },
    },
  },
  required: ['findings'],
};

const VERDICT = {
  type: 'object',
  properties: {
    real: { type: 'boolean', description: '실제 결함이면 true, 오탐이면 false' },
    reason: { type: 'string' },
    correctedDetail: { type: 'string', description: '실제 결함이면 정확히 다듬은 설명' },
  },
  required: ['real', 'reason'],
};

const CTX = `
프로젝트: /home/user/productivity-app (React+TS, 한국 식품공장 MES)
핵심 파일: src/lib/materialWorkbook.ts — ExcelJS 로 "수식이 살아있는" 원재료비 분석 워크북을 만든다.
관련: src/lib/materialUsage.ts, src/lib/monthlyProduction.ts, src/lib/bomExpansion.ts,
      src/lib/wasteCompute.ts, src/lib/ambientProducts.ts, src/pages/MaterialAnalysis.tsx

워크북 시트: 요약 / 생산량 / 단가 / 레시피계산 / 제품수익성 / 원재료집계
- 레시피계산: 한 줄 = 품목×원재료. 사용량 = 개당g × 생산EA, 금액 = 사용량 × 단가.
- 단가: 원재료별 두 달 단가(원/g) + 그룹(수동) + 순위 + '적용 그룹'(요약 H2/H3 선택방식 반영)
- 원재료집계: SUMIF 집계 + ERP 실제 출고량/금액
- 제품수익성: 제품별 재료비/공급가/원가율/믹스기준/한계이익
- 요약: ①~㉝ 지표 + 우측 G:L 패널(선택방식, 전체vs고단가 비교) + 자동 해석 문장

사용자는 이 파일을 실제 Microsoft Excel 에서 열어 경영진 보고에 쓴다. 숫자가 틀리면 안 된다.
파일 전체를 정독하고 실제 결함만 보고하라. 스타일 취향은 보고하지 마라.
`;

const DIMENSIONS = [
  {
    key: 'formula',
    prompt: `${CTX}

관점: **엑셀 수식 정확성**. src/lib/materialWorkbook.ts 를 끝까지 정독하고 생성되는 수식을 손으로 전개해 검증하라.
집중 점검:
- 시트 간 참조 범위의 off-by-one (헤더행 포함/누락, 마지막행 계산: qtyLast/priceLast/calcLast/aggLast/profitLast)
- VLOOKUP 열 인덱스가 실제 컬럼 순서와 맞는지 (특히 단가!A:L 12번째, 생산량!A:E 4/5번째)
- SUMIF/SUMIFS/COUNTIFS 의 범위 길이 불일치
- RANK 의 동점 처리, 0/빈값이 순위에 섞이는지
- SUMPRODUCT 에서 빈칸이 0으로 취급되어 의도치 않게 매칭되는지
- 0 나누기, 빈 문자열("")이 산술에 섞일 때 #VALUE!
- N() 함수를 문자열/빈칸에 쓸 때의 동작
- 순환참조 가능성 (단가 사용량 ← 레시피계산 ← 단가 단가)
- 자동 해석 문장의 TEXT/IF 중첩 괄호와 부호 처리
반드시 파일을 Read 로 전부 읽어라. 근거 없는 추측 금지.`,
  },
  {
    key: 'data',
    prompt: `${CTX}

관점: **데이터 파이프라인 정확성**. buildProducts / ingMaster / priceOf / outOf / pickFull / findAmbientErp 경로를 검증하라.
집중 점검:
- 원재료 키 규칙(normalizeCode vs CODE_KEY_PREFIX)이 앱(materialUsage.computeMonthlyUsage)과 정확히 같은지
- outOf() 의 키 매칭이 materialOutflow 저장 키(ProductSettings 의 ingKey)와 일치하는지
- 같은 이름 다른 코드 / 같은 코드 다른 이름 원재료가 합쳐지거나 갈라지는지
- 실온 배합 나눗셈(gPerBatch/batchPieces)이 앱과 동일한지
- pickFull 이 -01/-51 변형 중 잘못된 코드를 고를 수 있는 경우
- 품목키 중복 가능성 (냉장 전체코드 vs 실온 ERP코드 vs 제품명 충돌) → VLOOKUP 이 첫 행만 잡는 문제
- 생산량/사용량의 반올림 손실
관련 파일들을 모두 Read 해서 대조하라.`,
  },
  {
    key: 'analytics',
    prompt: `${CTX}

관점: **분석 지표 정의의 타당성**. 회계·원가 관점에서 지표가 옳게 정의됐는지 따져라.
집중 점검:
- ⑳ 믹스효과 = SUM(A월 제품원가율 × B월 매출비중) - A월 원가율, ㉑ = B월원가율 - 믹스기준. 이 분해가 수학적으로 완결(합=총증감)인지, 신규/단종 제품이 있을 때도 성립하는지
- ⑧ 실제÷이론 을 '수율'로 해석하는 것의 타당성 (재고 증감 포함 문제)
- ㉔ 고단가 원단위(g/EA)의 분모가 '전체 생산량'인 것이 옳은지
- ㉘ 고단가 제품 평균 공급가와 ㉖ 매출비중의 정의
- ⑭ 생산량 기준 고단가 비중이 앱 화면 정의와 같은지
- 전체vs고단가 비교표 마지막 열의 의미(비중 vs 상대차이)가 행마다 뒤섞여 오해를 부르는지
- 자동 판정문(±1% 임계)이 잘못된 결론을 낼 수 있는 조합
숫자 예시를 들어 반례를 제시하라.`,
  },
  {
    key: 'excel-compat',
    prompt: `${CTX}

관점: **실제 Microsoft Excel 호환성**. 이 파일은 아직 진짜 Excel 로 열어본 적이 없다.
집중 점검:
- ExcelJS 가 쓰는 dataValidation(list) 형식이 Excel 에서 드롭다운으로 뜨는지
- 한글 시트명을 수식에서 따옴표 없이 참조해도 되는지 (요약!$H$2, 레시피계산!$A$2 등)
- mergeCells 한 셀에 수식/서식을 넣을 때의 문제
- numFmt 문자열(#,##0.000 / 0.00% 등)의 유효성
- autoFilter 범위가 실제 데이터 범위와 어긋나는 경우
- fullCalcOnLoad 로 열 때 재계산되는지, 캐시값 없는 수식이 0으로 보이는 문제
- RANK vs RANK.EQ, N(), SUMPRODUCT 의 구버전 호환
- 열 너비/행 높이/조건부 서식 누락으로 읽기 어려운 부분
- 파일 크기/행 수(레시피계산 3천줄, 제품수익성 190줄) 에서의 성능
ExcelJS 문서를 WebFetch 로 확인해도 좋다.`,
  },
  {
    key: 'edge',
    prompt: `${CTX}

관점: **엣지 케이스와 실패 모드**. 실제 운영 데이터에서 깨질 수 있는 상황을 찾아라.
집중 점검:
- 제품 0개 / 원재료 0개 / 레시피 0개 인 달
- 레시피는 있는데 생산량 0, 반대로 생산량 있는데 레시피 없음
- 단가가 0이거나 없는 원재료가 섞였을 때 금액이 조용히 0이 되는 문제
- 실온만 있고 냉장이 없는 달, 그 반대
- 품목명/원재료명에 큰따옴표·쉼표·줄바꿈이 들어간 경우 (수식 문자열 깨짐)
- 시트명 최대 31자, 셀 문자열 최대 32767자
- 요약 우측 패널(G:L)이 좌측 표와 행이 겹쳐 덮어쓰는 경우
- 고단가 선택방식 드롭다운 값과 수식의 문자열 비교가 어긋나는 경우(공백/오타)
- 사용자가 행을 삽입/삭제했을 때 수식이 깨지는 정도
코드를 읽고 실제로 재현 가능한 시나리오만 보고하라.`,
  },
];

phase('Review');
const results = await pipeline(
  DIMENSIONS,
  (d) => agent(d.prompt, { label: `review:${d.key}`, phase: 'Review', schema: FINDINGS, effort: 'high' }),
  (res, d) => {
    const fs = (res && res.findings) || [];
    if (fs.length === 0) return [];
    return parallel(fs.slice(0, 8).map((f) => () =>
      agent(`${CTX}

아래 지적을 **반박**하라. 기본 입장은 "오탐(false positive)"이며, 코드를 직접 읽어 반박이 불가능할 때만 실제 결함으로 인정하라.

제목: ${f.title}
파일: ${f.file} ${f.line || ''}
심각도: ${f.severity}
설명: ${f.detail}
시나리오: ${f.scenario}

반드시 해당 파일을 Read 해서 실제 코드로 확인하라. 확신이 없으면 real=false.`,
        { label: `verify:${d.key}:${(f.title || '').slice(0, 18)}`, phase: 'Verify', schema: VERDICT, effort: 'high' })
        .then((v) => ({ ...f, dim: d.key, verdict: v }))
    ));
  }
);

const all = results.flat().filter(Boolean);
const confirmed = all.filter((f) => f.verdict && f.verdict.real);
log(`검토 ${all.length}건 → 확정 ${confirmed.length}건`);

phase('Synthesize');
const summary = await agent(`${CTX}

아래는 5개 관점 검토 후 반박 검증을 통과한 확정 결함 목록이다(JSON):

${JSON.stringify(confirmed, null, 2)}

이것들을 한국어로 정리하라:
1) 심각도순(critical→low) 정렬
2) 중복/유사 항목 병합
3) 각 항목: [무엇이 틀렸나] [어떤 상황에서 드러나나] [정확한 수정 방법(파일·코드 수준)]
4) 마지막에 '수정 우선순위 TOP 5' 를 번호로

수정 방법은 실제 코드에 바로 적용할 수 있을 만큼 구체적으로 써라.`,
  { label: 'synthesize', phase: 'Synthesize', effort: 'high' });

return { total: all.length, confirmed: confirmed.length, summary, findings: confirmed };
