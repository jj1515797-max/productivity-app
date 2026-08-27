export const meta = {
  name: 'yield-compare-audit',
  description: '원재료수율 분석의 전월/전년 비교 로직 전면 검토',
  phases: [
    { title: 'Review', detail: '4개 관점 병렬 검토' },
    { title: 'Verify', detail: '심각 지적만 반박 검증' },
    { title: 'Synthesize', detail: '확정 결함 정리' },
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
          line: { type: 'string', description: '줄번호 또는 코드 조각' },
          severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
          detail: { type: 'string' },
          scenario: { type: 'string', description: '구체적 숫자 입력 → 잘못된 출력' },
          fix: { type: 'string' },
        },
        required: ['title', 'severity', 'detail', 'scenario', 'fix'],
      },
    },
  },
  required: ['findings'],
};
const VERDICT = {
  type: 'object',
  properties: {
    real: { type: 'boolean' },
    reason: { type: 'string' },
    correctedDetail: { type: 'string' },
  },
  required: ['real', 'reason'],
};

const CTX = `
파일: /home/user/productivity-app/src/pages/YieldAnalysis.tsx  (반드시 전체를 Read 할 것)
관련: src/lib/materialUsage.ts (computeMonthlyUsage), src/lib/monthlyProduction.ts,
      src/lib/bomExpansion.ts, src/lib/wasteCompute.ts (키 정규화), src/pages/ProductSettings.tsx (MaterialInputPanel)

용도: 한국 식품공장 원재료수율 관리. 경영진 보고에 그대로 쓰인다. 숫자가 틀리면 안 된다.

정의
  표준소요량 = 완제품 생산수량 × BOM 배합비   (앱이 자동 계산, 반제품은 원물로 펼침)
  실제 투입중량 = 사용자가 월별로 입력 (materialInput/{YYYY-MM}.inputs[원재료키] = g)
  원재료수율 = 표준소요량 ÷ 실제투입
  LOSS = 실제투입 − 표준소요,  LOSS율 = LOSS ÷ 실제투입 = 1 − 수율
  ※ 이 공장 BOM 은 이미 공정 로스가 반영된 실투입 기준이라 수율이 100% 를 넘는 게 정상인 원재료가 많다.
    (예: 멥쌀은 BOM 이 세척 후 기준, 매입은 원물 기준이라 구조적으로 120% 대)
  ※ 그래서 절대값보다 '전월/전년 대비 증감(%p)' 이 핵심 지표다.

두 가지 화면
  1) 월 비교 모드 — 기준월 vs 비교월(전년동월 또는 전월). 원재료별 표 + 요약 카드 + TOP3 두 개
  2) 월별 추이 모드 — 기간 내 월별 히트맵 + 월별 데이터 점검표

최근에 고친 것 (재발/부작용 확인 필요)
  · 수율 20% 미만 / 200% 초과(RANGE_LO/RANGE_HI)는 데이터 이상으로 보고
    TOP3·가중평균·전월대비 집계에서 제외
  · 전월 대비를 like-for-like 로: 두 달 모두 정상 범위인 원재료만으로
    각각 Σ표준÷Σ실투입 을 내어 비교 (wCur, wPrev)
  · 월별 표준소요량을 localStorage 에 캐시 (yieldStd2: 접두사)

실제 결함만 보고하라. 스타일 취향·리팩터링 제안은 제외.
`;

const DIMS = [
  {
    key: 'compare',
    prompt: `${CTX}

관점: **비교 로직의 수학적 정합성**. 전월/전년 비교가 틀릴 수 있는 모든 경로를 찾아라.
집중 점검:
- cmpMonth 계산(shiftMonth ±12/±1)이 연도 경계·월말에서 정확한가
- wCur / wPrev 가 정말 같은 원재료 집합·같은 가중 기준으로 계산되는가
- 원재료별 deltaPP = (yield − prevYield) × 100 이 %p 로서 올바른가.
  수율이 100%를 넘는 원재료(멥쌀 120%)에서 %p 차이가 의미를 갖는가
- 요약 카드의 가중평균 수율(valid 전체)과 전월대비(prevValid 부분집합)를
  나란히 보여주는 것이 오해를 부르지 않는가
- dropCount(임계 이상 하락 종수)가 이상치 제외 규칙과 일관되는가
- 신규 원재료(비교월에 없음)·단종 원재료(당월에 없음)가 어떻게 처리되는가
- 추이 모드의 avg / lastVsAvg / range 가 결측월(null)을 어떻게 다루는가.
  일부 달만 값이 있는 원재료의 평균이 왜곡되지 않는가
- 추이 모드 월별 '전체 수율' 과 월 비교 모드 '가중평균 수율' 이 같은 달에 대해 일치하는가
반드시 숫자 예시로 반례를 제시하라.`,
  },
  {
    key: 'data',
    prompt: `${CTX}

관점: **데이터 수집·매칭**. 비교 대상 두 달의 데이터가 제대로·동일 규칙으로 모이는지.
집중 점검:
- 원재료 키 규칙이 표준소요량(computeMonthlyUsage 의 UsageRow.key)과
  실투입 입력(ProductSettings 의 matInputKey)에서 완전히 동일한가.
  코드 있는 것/없는 것, 대소문자, 공백, CODE_KEY_PREFIX 처리
- 같은 원재료가 어떤 달엔 코드로, 어떤 달엔 이름으로 들어오면 두 달이 다른 키가 되어
  비교가 깨지는가
- 제외 키워드(excludeTerms) 판정이 두 달에 동일하게 적용되는가.
  이름이 달라지면(단가표 정식명 vs 레시피명) 한 달만 제외될 수 있는가
- 반제품 펼침(expandRecipeMap/expandAmbientRecipeMap)이 두 달에 동일하게 적용되는가
- localStorage 캐시(yieldStd2)가 레시피·단가 변경 후 stale 값을 쓰는 경로.
  캐시 키에 레시피 버전이 없는데 안전한가. 월 비교 모드는 캐시를 안 쓰고
  추이 모드만 쓰는데 두 모드 결과가 어긋날 수 있는가
- fetchMonth 의 날짜 범위 \`\${month}-31\` 이 30일/28일 달에서 문제되는가
- 실투입 0 과 미입력의 구분이 비교 로직 전체에서 일관되는가
관련 파일을 모두 Read 해서 대조하라.`,
  },
  {
    key: 'edge',
    prompt: `${CTX}

관점: **엣지 케이스**. 실제 운영에서 깨질 상황을 찾아라.
집중 점검:
- 비교월에 생산 데이터가 아예 없는 달(앱 도입 전, 예: 2026-01) → prevYield, 카드, TOP3
- 비교월 실투입이 통째로 없을 때 cmpHasData 경고와 실제 계산의 일치
- 표준소요 0 / 실투입 0 / 둘 다 0 인 원재료
- 수율이 정확히 RANGE_LO(20%) 또는 RANGE_HI(200%) 인 경계값
- threshold(임계 %p)를 0 이나 음수로 넣었을 때
- 추이 기간이 1개월일 때 range·avg·lastVsAvg
- 추이 기간이 24개월을 넘길 때(months.length < 24 제한)
- fromM > toM 인 경우
- 원재료가 0종일 때 각 집계(Math.max/min, 나눗셈)
- 엑셀 다운로드에서 null 값·%p 서식
코드를 읽고 재현 가능한 것만 보고하라.`,
  },
  {
    key: 'label',
    prompt: `${CTX}

관점: **표시와 계산의 불일치**. 화면에 쓰인 라벨·설명이 실제 계산과 다른 곳을 찾아라.
경영진 보고에 그대로 나가므로, 오해를 부르는 표기는 결함으로 본다.
집중 점검:
- '이상 원재료 TOP 3 · 전월 대비 하락폭' 의 부제가 "작년보다 나빠진 것" 으로 고정돼 있는데
  전월 모드일 때도 맞는가
- 카드 '가중평균 수율' 과 '전월 대비 (N종)' 의 모수가 다른 것이 표기로 드러나는가
- '⑥ 26-06' 같은 열 제목이 전년동월 모드에서도 올바른가
- LOSS 금액이 어느 달 단가로 계산되는지 화면에 드러나는가
- 추이 모드 '최근−평균' 의 '최근' 이 마지막 달인지, 값이 있는 마지막 달인지
- 데이터 점검 문구가 실제 판정 조건과 일치하는가
- 엑셀 시트의 열 제목·서식이 화면과 일치하는가
- 수율 100% 초과 안내가 이 공장 BOM 특성(로스 반영)과 맞게 쓰여 있는가
화면 문구를 코드에서 정확히 인용하며 지적하라.`,
  },
];

phase('Review');
const results = await pipeline(
  DIMS,
  (d) => agent(d.prompt, { label: `review:${d.key}`, phase: 'Review', schema: FINDINGS, effort: 'high' }),
  (res, d) => {
    const fs = ((res && res.findings) || []).filter((f) => f.severity === 'critical' || f.severity === 'high');
    if (fs.length === 0) return [];
    return parallel(fs.slice(0, 2).map((f) => () =>
      agent(`${CTX}

아래 지적을 **반박**하라. 기본 입장은 오탐이며, 코드를 직접 읽어 반박이 불가능할 때만 실제 결함으로 인정한다.

제목: ${f.title}
위치: ${f.line || ''}
심각도: ${f.severity}
설명: ${f.detail}
시나리오: ${f.scenario}

반드시 YieldAnalysis.tsx 를 Read 해서 실제 코드로 확인하라. 확신이 없으면 real=false.`,
        { label: `verify:${d.key}`, phase: 'Verify', schema: VERDICT, effort: 'high' })
        .then((v) => ({ ...f, dim: d.key, verdict: v }))
    ));
  }
);

const all = results.flat().filter(Boolean);
const confirmed = all.filter((f) => f.verdict && f.verdict.real);
log(`심각 지적 ${all.length}건 검증 → 확정 ${confirmed.length}건`);

phase('Synthesize');
const summary = await agent(`${CTX}

반박 검증을 통과한 확정 결함:
${JSON.stringify(confirmed, null, 2)}

한국어로 정리하라:
1) 심각도순 정렬, 중복 병합
2) 각 항목: [무엇이 틀렸나] [어떤 상황에서 드러나나] [정확한 수정 방법(코드 수준)]
3) 마지막에 '수정 우선순위' 번호 목록
수정 방법은 바로 적용 가능할 만큼 구체적으로.`,
  { label: 'synthesize', phase: 'Synthesize', effort: 'high' });

return { total: all.length, confirmed: confirmed.length, summary, findings: confirmed };
