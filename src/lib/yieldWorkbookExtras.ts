/** 원재료수율 엑셀 — 「보는 방법」·「검증」·「표준소요 근거」 시트
 *
 *  검증 시트는 앱이 낸 숫자를 엑셀 수식으로 '다시' 계산해 맞는지 대조한다.
 *  - 표준소요: 「표준소요 근거」 시트의 (생산량 × 개당g) 를 SUMIF 로 원재료별 합산
 *  - 수율·LOSS·LOSS금액: 수율 시트의 표준소요·실투입·단가로 재계산
 *  수식이 들어가 있어서, 근거 시트의 생산량이나 개당g 을 고치면 검증 결과가 바로 바뀐다
 *  (= 레시피·생산량이 틀렸을 때 숫자가 얼마나 달라지는지 직접 시험해 볼 수 있다).
 */
import type ExcelJS from 'exceljs';
import type { UsageContrib } from './materialUsage';

export interface AuditRow {
  key: string;
  name: string;
  code: string;
  stdG: number;
  actG: number;
  hasInput: boolean;
  yield: number | null;
  prevYield: number | null;
  lossG: number | null;
  lossAmt: number | null;
  pricePerG: number;
  /** 합계·카드 집계에 들어가나 (수율 계산 가능 + 정상 범위) — 수율 시트 '집계' 열 */
  included: boolean;
}

export interface AuditCtx {
  month: string;
  cmpMonth: string;
  cmpLabel: string;            // '전월' | '전년동월'
  dataSheet: string;           // 수율 시트 이름
  /** 수율 시트에서 각 열의 글자 (C, D …) */
  col: { s: string; a: string; y: string; l: string; la: string; pk: string; f: string };
  rows: AuditRow[];            // 수율 시트와 같은 순서 (2행부터)
  sumRowNo: number;            // 수율 시트 합계 행 번호
  contribs: UsageContrib[];
  missingCold: string[];
  missingAmbient: string[];
  missingPrices: string[];
  remapped: string[];
  coveragePct: number | null;
  missingQty: number;
  totalQty: number;
  cmpDiag: { hasInput: boolean; qty: number; baseQty: number; partial: boolean };
  threshold: number;
  rangeLo: number;
  rangeHi: number;
  excludeText: string;
  recipeSource: string;        // '분석용 레시피(수율 DB)' | 'BOM 레시피'
  filterNote: string;          // 검색·분류 필터가 걸려 있으면 그 설명
}

const NAVY = 'FF1F3864';
const LIGHT = 'FFE8EEF7';
const OK_FILL = 'FFE2EFDA';
const BAD_FILL = 'FFFCE4E4';
const WARN_FILL = 'FFFFF2CC';

const q = (sheet: string) => `'${sheet.replace(/'/g, "''")}'`;

function titleRow(ws: ExcelJS.Worksheet, text: string, size = 14) {
  const r = ws.addRow([text]);
  r.font = { bold: true, size, color: { argb: NAVY } };
  r.height = size + 10;
  return r;
}
function sectionRow(ws: ExcelJS.Worksheet, text: string, span: number) {
  const r = ws.addRow([text]);
  r.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  for (let i = 1; i <= span; i++) {
    r.getCell(i).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: NAVY } };
  }
  return r;
}
function headRow(ws: ExcelJS.Worksheet, vals: string[]) {
  const r = ws.addRow(vals);
  r.font = { bold: true };
  r.eachCell((c) => {
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: LIGHT } };
    c.alignment = { vertical: 'middle', wrapText: true };
    c.border = { bottom: { style: 'thin', color: { argb: 'FF9FB0CC' } } };
  });
  return r;
}
function wrap(r: ExcelJS.Row) {
  r.eachCell((c) => { c.alignment = { vertical: 'top', wrapText: true }; });
  return r;
}

/* ======================================================================
   보는 방법
   ====================================================================== */
export function addGuideSheet(wb: ExcelJS.Workbook, ctx: AuditCtx) {
  const ws = wb.addWorksheet('보는 방법', { properties: { tabColor: { argb: 'FF2F75B5' } } });
  ws.columns = [{ width: 22 }, { width: 44 }, { width: 60 }];

  titleRow(ws, `원재료수율 분석 — 보는 방법 (${ctx.month}, 비교: ${ctx.cmpLabel} ${ctx.cmpMonth})`);
  wrap(ws.addRow(['',
    '원재료를 레시피대로만 썼다면 들어갔어야 할 양(표준소요)과 실제로 창고에서 나간 양(실투입)을 비교해,'
    + ' 얼마나 버려졌는지(LOSS)와 그 금액을 원재료별로 보여줍니다.']));
  ws.mergeCells(ws.rowCount, 2, ws.rowCount, 3);
  ws.addRow([]);

  sectionRow(ws, '1. 한 줄 요약', 3);
  const summary: [string, string][] = [
    ['수율', '표준소요 ÷ 실투입. 100% 면 레시피대로 딱 맞게 썼다는 뜻, 낮을수록 많이 버림.'],
    ['LOSS', '실투입 − 표준소요. 레시피보다 더 쓴 양. 여기에 단가를 곱하면 LOSS 금액.'],
    ['증감(%p)', `이번 달 수율 − ${ctx.cmpLabel} 수율. 마이너스면 나빠진 것.`],
    ['합계 행', '화면 카드와 같은 기준 — 수율이 계산되고 정상 범위인 원재료(「집계」 열 = 포함)만 더합니다. 수율은 퍼센트를 평균 내지 않고 「표준소요 합계 ÷ 실투입 합계」 (가중평균).'],
  ];
  summary.forEach(([a, b]) => { const r = wrap(ws.addRow([a, b])); r.getCell(1).font = { bold: true }; ws.mergeCells(r.number, 2, r.number, 3); });
  ws.addRow([]);

  sectionRow(ws, '2. 읽는 순서 (추천)', 3);
  [
    ['① 합계 행', '전체 수율과 증감부터 봅니다. 비고에 「미입력 N종 포함」 이 있으면 합계 수율이 실제보다 높게 나온 것입니다.'],
    ['② 증감이 빨간 원재료', `${ctx.cmpLabel}보다 ${ctx.threshold}%p 이상 떨어진 원재료입니다. 원인 규명 1순위.`],
    ['③ LOSS 금액 큰 원재료', '수율이 괜찮아 보여도 비싼 원재료는 조금만 새도 금액이 큽니다. LOSS 금액 열로 정렬해 보세요.'],
    ['④ 비고 열', '「데이터 이상」「미입력」「표준소요 0」 이 붙은 행은 숫자보다 데이터부터 고쳐야 합니다.'],
    ['⑤ 검증 시트', '숫자가 이상하면 「검증」 시트에서 계산이 맞는지, 데이터에 빠진 게 없는지 확인합니다.'],
  ].forEach(([a, b]) => { const r = wrap(ws.addRow([a, b])); r.getCell(1).font = { bold: true }; ws.mergeCells(r.number, 2, r.number, 3); });
  ws.addRow([]);

  sectionRow(ws, '3. 열 설명', 3);
  headRow(ws, ['열', '뜻', '계산 / 읽는 법']);
  [
    ['원재료 / ERP코드', '레시피에 들어가는 원재료', '코드가 있으면 코드로, 없으면 이름으로 짝을 맞춥니다.'],
    ['② 표준소요 (kg)', '레시피대로 썼다면 필요한 양', 'Σ (제품별 생산량 × 그 제품 1개당 이 원재료 g). 반제품은 원물까지 풀어서 계산. 근거는 「표준소요 근거」 시트.'],
    ['① 실제투입 (kg)', '실제로 쓴 양', '설정 › 실제 투입중량 에 입력한 값 (ERP 수불 불출량). 빈칸 = 미입력, 0 = 그 달 안 씀.'],
    ['③ 원재료수율', '레시피 대비 실제 효율', '② ÷ ①. 예: 표준 80kg, 실투입 100kg → 80%.'],
    [`⑥ ${ctx.cmpMonth} 수율`, `${ctx.cmpLabel} 같은 원재료 수율`, '같은 방식으로 계산한 비교월 값.'],
    ['⑦ 증감(%p)', '이번 달 − 비교월', `예: 80% → 76% 면 -4.0. ${ctx.threshold}%p 이상 하락은 빨간색.`],
    ['④ LOSS (kg)', '레시피보다 더 쓴 양', '① − ②. 마이너스면 레시피보다 덜 썼다는 뜻 (보통 레시피·재고 기준 차이).'],
    ['⑤ LOSS율', '실투입 중 버려진 비율', '④ ÷ ① = 1 − 수율.'],
    ['LOSS 금액(원)', '버려진 양의 돈 가치', '④ × 그 달 재고평가 단가.'],
    ['단가(원/kg)', 'LOSS 금액 계산에 쓴 단가', '설정 › 재고평가 단가 의 그 달 값. 0 이면 단가 미등록 → LOSS 금액도 0.'],
    ['집계', '합계에 들어갔나', '포함 = 합계·카드에 반영. 제외 = 실투입 미입력·표준소요 0·실투입 0·수율 범위 밖이라 합계에서 뺌 (행은 그대로 보임).'],
    ['비고', '데이터 상태 경고', '아래 4번 참고.'],
    ['원인 점검 포인트', '화면에서 적어 둔 메모', '분석 화면 메모 칸의 내용.'],
  ].forEach((v) => wrap(ws.addRow(v)).getCell(1).font = { bold: true });
  ws.addRow([]);

  sectionRow(ws, '4. 색·비고의 의미', 3);
  headRow(ws, ['표시', '의미', '어떻게 할까']);
  [
    ['빨간 증감', `${ctx.cmpLabel}보다 ${ctx.threshold}%p 이상 하락`, '작업 방법·원료 상태·계량 변경이 있었는지 현장 확인.'],
    ['보라색 수율', '수율 100% 초과 (레시피보다 덜 씀)', '레시피 g 이 실제보다 크거나, 월말 재고 이월·실투입 입력 누락 가능성.'],
    ['회색 + ⚠ 데이터 이상', `수율이 ${ctx.rangeLo * 100}~${ctx.rangeHi * 100}% 범위 밖`, '자릿수 오입력·단위(g/kg) 착오 가능. 합계 외 통계·TOP3 에서는 제외.'],
    ['실투입 미입력', '실투입 칸이 비어 있음', '설정 › 실제 투입중량 에서 입력. 미입력 상태면 합계 수율이 부풀려짐.'],
    ['그 달 미사용 (0 입력)', '실투입을 0 으로 입력', '정말 안 썼는지 확인 (표준소요는 있는데 0 이면 이상).'],
    ['표준소요 0', '레시피에서 이 원재료가 안 나옴', '실투입 코드가 레시피 코드와 다르거나 레시피에 누락.'],
  ].forEach((v) => wrap(ws.addRow(v)).getCell(1).font = { bold: true });
  ws.addRow([]);

  sectionRow(ws, '5. 계산 규칙 (이 파일에 적용된 설정)', 3);
  [
    ['기준월 / 비교월', `${ctx.month} / ${ctx.cmpMonth} (${ctx.cmpLabel})`],
    ['레시피 기준', ctx.recipeSource],
    ['생산량 기준', '월별현황과 같은 규칙: 잔여량(물류) 입력한 날은 계획+잔여량, 아니면 호기 입력 실적 합계. 실온은 실온 입력 수량.'],
    ['단가 기준', `재고평가 단가 ${ctx.month}. 코드로 먼저 찾고 없으면 원재료명으로.`],
    ['제외 원재료', ctx.excludeText || '(없음)'],
    ['데이터 이상 범위', `수율 ${ctx.rangeLo * 100}% 미만 또는 ${ctx.rangeHi * 100}% 초과`],
    ['증감 경고 기준', `${ctx.threshold}%p 이상 하락`],
    ['필터', ctx.filterNote || '없음 (전체 원재료)'],
  ].forEach(([a, b]) => { const r = wrap(ws.addRow([a, b])); r.getCell(1).font = { bold: true }; ws.mergeCells(r.number, 2, r.number, 3); });
  ws.addRow([]);

  sectionRow(ws, '6. 자주 헷갈리는 것', 3);
  [
    ['퍼센트를 평균 내면 안 되나요?', '소량 원재료(예: 1kg 쓰는 향신료)가 50% 여도 전체에 주는 영향은 작습니다. 단순평균하면 이런 원재료가 과대 반영되므로 합계끼리 나눕니다. 「검증」 시트에 두 값이 같이 나옵니다.'],
    ['수율이 100% 넘으면 좋은 건가요?', '대부분은 좋은 게 아니라 기준 차이입니다 (레시피 g 과다, 월말 재고를 다음 달로 넘김, 실투입 일부 누락).'],
    ['이번 달만 유독 나쁜데요?', '재고조사를 한 달 늦게/일찍 반영하면 한 달은 나쁘고 다음 달은 좋아 보입니다. 월별 추이로 두세 달을 같이 보세요.'],
    ['LOSS 금액이 0 이에요', '그 달 재고평가 단가가 등록되지 않은 원재료입니다. 단가(원/kg) 열이 0 인지 확인하세요.'],
  ].forEach(([a, b]) => { const r = wrap(ws.addRow([a, b])); r.getCell(1).font = { bold: true }; ws.mergeCells(r.number, 2, r.number, 3); });

  return ws;
}

/* ======================================================================
   표준소요 근거
   ====================================================================== */
export const EVID_SHEET = '표준소요 근거';

export function addEvidenceSheet(wb: ExcelJS.Workbook, ctx: AuditCtx) {
  const ws = wb.addWorksheet(EVID_SHEET, { properties: { tabColor: { argb: 'FF808080' } } });
  ws.columns = [
    { header: '원재료key', key: 'k', width: 16 },
    { header: '원재료', key: 'n', width: 26 },
    { header: 'ERP코드', key: 'c', width: 12 },
    { header: '구분', key: 't', width: 7 },
    { header: '제품코드/제품', key: 'p', width: 16 },
    { header: '제품명', key: 'pl', width: 28 },
    { header: '생산량(EA)', key: 'q', width: 12 },
    { header: '개당 g', key: 'g', width: 11 },
    { header: '소요 g (= 생산량×개당g)', key: 'sg', width: 18 },
    { header: '소요 kg', key: 'sk', width: 12 },
  ];
  const hr = ws.getRow(1);
  hr.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  hr.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: NAVY } };
  hr.alignment = { wrapText: true, vertical: 'middle' };
  hr.height = 30;

  const meta = new Map(ctx.rows.map((r) => [r.key, r]));
  const order = new Map(ctx.rows.map((r, i) => [r.key, i]));
  const list = ctx.contribs
    .filter((c) => meta.has(c.key))
    .sort((a, b) => (order.get(a.key)! - order.get(b.key)!) || b.grams - a.grams);
  list.forEach((c) => {
    const m = meta.get(c.key)!;
    const row = ws.addRow({
      k: c.key, n: m.name, c: m.code, t: c.kind === 'cold' ? '냉장' : '실온',
      p: c.product, pl: c.label, q: c.qty, g: c.gPerUnit,
    });
    const rn = row.number;
    row.getCell('sg').value = { formula: `G${rn}*H${rn}`, result: c.qty * c.gPerUnit };
    row.getCell('sk').value = { formula: `I${rn}/1000`, result: (c.qty * c.gPerUnit) / 1000 };
    row.getCell('q').numFmt = '#,##0.##';
    row.getCell('g').numFmt = '#,##0.0##';
    row.getCell('sg').numFmt = '#,##0.0';
    row.getCell('sk').numFmt = '#,##0.000';
  });
  ws.autoFilter = { from: 'A1', to: `J${Math.max(1, ws.rowCount)}` };
  ws.views = [{ state: 'frozen', ySplit: 1, xSplit: 2 }];
  return ws;
}

/* ======================================================================
   검증
   ====================================================================== */
export function addAuditSheet(wb: ExcelJS.Workbook, ctx: AuditCtx) {
  const ws = wb.addWorksheet('검증', { properties: { tabColor: { argb: 'FF548235' } } });
  ws.columns = [
    { width: 26 }, { width: 16 }, { width: 14 }, { width: 14 }, { width: 10 },
    { width: 13 }, { width: 11 }, { width: 11 }, { width: 10 },
    { width: 12 }, { width: 12 }, { width: 10 },
    { width: 12 }, { width: 14 }, { width: 14 }, { width: 10 }, { width: 14 },
  ];
  const D = q(ctx.dataSheet);
  const E = q(EVID_SHEET);
  const N = ctx.rows.length;
  const first = 2, last = N + 1;
  const c = ctx.col;

  titleRow(ws, `원재료수율 검증 — ${ctx.month}`);
  wrap(ws.addRow(['이 시트의 초록/빨강 판정은 엑셀 수식이 직접 다시 계산한 결과입니다. 「표준소요 근거」 시트의 생산량·개당g 을 고치면 판정이 즉시 바뀝니다.']));
  ws.mergeCells(ws.rowCount, 1, ws.rowCount, 12);
  ws.addRow([]);

  /* ---------- A. 한눈에 ---------- */
  sectionRow(ws, 'A. 한눈에 — 이 결과를 믿어도 되나?', 12);
  const verdictRowNo = ws.rowCount + 1;
  ws.addRow(['종합 판정']); // 아래 C 표 범위를 알고 나서 수식을 채운다
  ws.getRow(verdictRowNo).font = { bold: true, size: 12 };
  const note = ws.addRow(['',
    '계산 검산 = 앱이 숫자를 제대로 더하고 나눴는가 · 데이터 점검 = 계산에 들어간 입력(레시피·실투입·단가)이 빠짐없는가. 둘 다 ✔ 여야 믿을 수 있는 결과입니다.']);
  ws.mergeCells(note.number, 2, note.number, 12);
  wrap(note);
  note.getCell(2).font = { color: { argb: 'FF666666' } };
  ws.addRow([]);

  /* ---------- B. 데이터 상태 점검 ---------- */
  sectionRow(ws, 'B. 데이터 상태 점검 — 계산 전에 입력이 빠진 곳', 12);
  headRow(ws, ['점검 항목', '결과', '판정', '', '', '무엇을 뜻하나 / 어떻게 고치나']);
  ws.mergeCells(ws.rowCount, 3, ws.rowCount, 5);
  ws.mergeCells(ws.rowCount, 6, ws.rowCount, 12);

  const noInput = ctx.rows.filter((r) => r.stdG > 0 && !r.hasInput);
  const odd = ctx.rows.filter((r) => (r.yield !== null && (r.yield < ctx.rangeLo || r.yield > ctx.rangeHi)));
  const over = ctx.rows.filter((r) => r.yield !== null && r.yield > 1 && r.yield <= ctx.rangeHi);
  const stdZero = ctx.rows.filter((r) => r.stdG <= 0 && r.actG > 0);
  const viewKeys = new Set(ctx.rows.map((r) => r.key));
  const noPrice = ctx.rows.filter((r) => viewKeys.has(r.key) && r.lossG !== null && !(r.pricePerG > 0));
  const names = (xs: { name: string }[], n = 8) => xs.slice(0, n).map((x) => x.name).join(', ') + (xs.length > n ? ` 외 ${xs.length - n}` : '');

  const checks: { item: string; val: string; level: 'ok' | 'warn' | 'bad'; help: string }[] = [
    {
      item: '레시피 커버리지',
      val: ctx.coveragePct === null ? '—' : `${ctx.coveragePct.toFixed(1)}% (${ctx.missingQty.toLocaleString()} / ${ctx.totalQty.toLocaleString()} EA 누락)`,
      level: ctx.coveragePct === null || ctx.coveragePct >= 99.5 ? 'ok' : ctx.coveragePct >= 90 ? 'warn' : 'bad',
      help: (ctx.missingCold.length || ctx.missingAmbient.length)
        ? `레시피 없는 제품: ${[...ctx.missingCold, ...ctx.missingAmbient].slice(0, 12).join(', ')}${ctx.missingCold.length + ctx.missingAmbient.length > 12 ? ' …' : ''} → 이 제품의 원재료는 표준소요에서 빠져 수율이 낮게 나옵니다. 레시피 등록 필요.`
        : '생산한 모든 제품에 레시피가 있습니다.',
    },
    {
      item: '실투입 미입력',
      val: `${noInput.length}종`,
      level: noInput.length === 0 ? 'ok' : 'warn',
      help: noInput.length ? `${names(noInput)} → 설정 › 실제 투입중량 에 입력. 미입력 상태면 합계 수율이 부풀려집니다.` : '모두 입력됨.',
    },
    {
      item: `수율 범위 밖 (${ctx.rangeLo * 100}~${ctx.rangeHi * 100}%)`,
      val: `${odd.length}종`,
      level: odd.length === 0 ? 'ok' : 'bad',
      help: odd.length ? `${names(odd)} → 자릿수·단위(g/kg) 오입력이나 코드 불일치 의심. 실투입 값을 먼저 확인.` : '없음.',
    },
    {
      item: '수율 100% 초과',
      val: `${over.length}종`,
      level: over.length === 0 ? 'ok' : 'warn',
      help: over.length ? `${names(over)} → 레시피 g 과다, 월말 재고 이월, 실투입 일부 누락 가능.` : '없음.',
    },
    {
      item: '실투입은 있는데 표준소요 0',
      val: `${stdZero.length}종`,
      level: stdZero.length === 0 ? 'ok' : 'warn',
      help: stdZero.length ? `${names(stdZero)} → 레시피에 없는 원재료이거나 실투입 코드가 레시피 코드와 다름.` : '없음.',
    },
    {
      item: '단가 미등록 (LOSS 금액 0)',
      val: `${noPrice.length}종`,
      level: noPrice.length === 0 ? 'ok' : 'warn',
      help: noPrice.length ? `${names(noPrice)} → 설정 › 재고평가 단가 ${ctx.month} 에 등록.` : '모두 단가 있음.',
    },
    {
      item: '이름으로 매칭한 실투입',
      val: `${ctx.remapped.length}종`,
      level: ctx.remapped.length === 0 ? 'ok' : 'warn',
      help: ctx.remapped.length ? `${ctx.remapped.slice(0, 8).join(', ')}${ctx.remapped.length > 8 ? ' …' : ''} → 실투입 코드가 레시피 코드와 달라 이름으로 짝지었습니다. 맞게 짝지어졌는지 확인.` : '모두 코드로 매칭.',
    },
    {
      item: `비교월(${ctx.cmpMonth}) 데이터`,
      val: !ctx.cmpDiag.hasInput ? '실투입 없음' : ctx.cmpDiag.qty <= 0 ? '생산 데이터 없음'
        : `생산 ${ctx.cmpDiag.qty.toLocaleString()} EA`,
      level: !ctx.cmpDiag.hasInput || ctx.cmpDiag.qty <= 0 ? 'bad' : ctx.cmpDiag.partial ? 'warn' : 'ok',
      help: !ctx.cmpDiag.hasInput || ctx.cmpDiag.qty <= 0 ? '비교월 수율·증감이 계산되지 않습니다.'
        : ctx.cmpDiag.partial ? '비교월 생산량이 기준월의 70% 미만 — 그 달 데이터가 덜 쌓였을 수 있습니다.' : '정상.',
    },
  ];
  const checkFirst = ws.rowCount + 1;
  checks.forEach((ck) => {
    const r = ws.addRow([ck.item, ck.val, ck.level === 'ok' ? '✔ 정상' : ck.level === 'warn' ? '△ 확인' : '✖ 문제', '', '', ck.help]);
    ws.mergeCells(r.number, 3, r.number, 5);
    ws.mergeCells(r.number, 6, r.number, 12);
    wrap(r);
    r.getCell(1).font = { bold: true };
    r.getCell(3).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: ck.level === 'ok' ? OK_FILL : ck.level === 'warn' ? WARN_FILL : BAD_FILL } };
    r.getCell(3).font = { bold: true };
  });
  const checkLast = ws.rowCount;
  ws.addRow([]);

  /* ---------- C. 합계 검산 ---------- */
  sectionRow(ws, 'C. 합계 검산 — 수율 시트 합계 행과 엑셀 재계산 비교', 12);
  headRow(ws, ['항목', '앱 값', '엑셀 재계산', '판정', '', '재계산 방법']);
  ws.mergeCells(ws.rowCount, 4, ws.rowCount, 5);
  ws.mergeCells(ws.rowCount, 6, ws.rowCount, 12);

  const inc = ctx.rows.filter((r) => r.included);
  const allStd = ctx.rows.reduce((a, r) => a + r.stdG, 0) / 1000;
  const sumStd = inc.reduce((a, r) => a + r.stdG, 0) / 1000;
  const sumAct = inc.reduce((a, r) => a + r.actG, 0) / 1000;
  const sumLoss = inc.reduce((a, r) => a + (r.lossG ?? 0), 0) / 1000;
  const sumAmt = inc.reduce((a, r) => a + (r.lossAmt ?? 0), 0);
  const evidStd = ctx.contribs.filter((x) => viewKeys.has(x.key)).reduce((a, x) => a + x.grams, 0) / 1000;
  const ys = inc.map((r) => r.yield).filter((v): v is number => v !== null);
  const simpleAvg = ys.length ? ys.reduce((a, b) => a + b, 0) / ys.length : null;

  const sr = ctx.sumRowNo;
  const rng = (col: string) => `${D}!${col}${first}:${col}${last}`;
  const F = rng(c.f);
  const sumif = (col: string) => `SUMIFS(${rng(col)},${F},"포함")`;
  const appRef = (col: string) => `IF(ISBLANK(${D}!${col}${sr}),"",${D}!${col}${sr})`;
  type SumLine = { label: string; app: ExcelJS.CellValue; calc: ExcelJS.CellValue; tol: number | null; fmt: string; how: string };
  const lines: SumLine[] = [
    {
      label: '표준소요 전체 (kg) — 근거 대조', app: { formula: `SUM(${rng(c.s)})`, result: allStd },
      calc: { formula: `SUM(${E}!J:J)`, result: evidStd }, tol: 0.01, fmt: '#,##0.0',
      how: '수율 시트 표준소요 열 전체 합 vs 「표준소요 근거」 시트의 생산량×개당g 합. 다르면 레시피 전개나 생산량 집계가 어긋난 것.',
    },
    {
      label: `표준소요 합계 (kg) — 집계 ${inc.length}종`, app: { formula: appRef(c.s), result: sumStd },
      calc: { formula: sumif(c.s), result: sumStd }, tol: 0.01, fmt: '#,##0.0',
      how: '수율 시트에서 「집계」 열이 포함인 행만 더한 값. 합계 행·화면 카드와 같은 기준.',
    },
    {
      label: '실투입 합계 (kg)', app: { formula: appRef(c.a), result: sumAct },
      calc: { formula: sumif(c.a), result: sumAct }, tol: 0.01, fmt: '#,##0.0',
      how: '「집계」 포함 행의 실투입 합.',
    },
    {
      label: '가중평균 수율', app: { formula: appRef(c.y), result: sumAct > 0 ? sumStd / sumAct : undefined },
      calc: { formula: `IFERROR(${sumif(c.s)}/${sumif(c.a)},"")`, result: sumAct > 0 ? sumStd / sumAct : '' },
      tol: 0.0005, fmt: '0.0%',
      how: '표준소요 합계 ÷ 실투입 합계 (집계 포함 행). 화면 「가중평균 수율」 카드와 같은 값.',
    },
    {
      label: '(참고) 단순평균 수율', app: '—',
      calc: { formula: `IFERROR(AVERAGEIFS(${rng(c.y)},${F},"포함"),"")`, result: simpleAvg ?? '' }, tol: null, fmt: '0.0%',
      how: '원재료별 수율 퍼센트를 그냥 평균 낸 값. 소량 원재료가 과대 반영돼 가중평균과 다르게 나오는 게 정상입니다 — 보고에는 가중평균을 쓰세요.',
    },
    {
      label: 'LOSS 합계 (kg)', app: { formula: appRef(c.l), result: sumLoss },
      calc: { formula: sumif(c.l), result: sumLoss }, tol: 0.01, fmt: '#,##0.0',
      how: '「집계」 포함 행의 LOSS(kg) 합.',
    },
    {
      label: 'LOSS 금액 합계 (원)', app: { formula: appRef(c.la), result: Math.round(sumAmt) },
      calc: { formula: `SUMPRODUCT((${F}="포함")*${rng(c.l)}*${rng(c.pk)})`, result: sumAmt }, tol: Math.max(2, inc.length), fmt: '#,##0',
      how: 'Σ(LOSS kg × 단가 원/kg), 집계 포함 행만. 행마다 반올림한 값을 더하므로 몇 원 차이는 정상. 화면 「LOSS 금액」 카드와 같은 값.',
    },
  ];
  const sumFirst = ws.rowCount + 1;
  let sumBad = 0;
  lines.forEach((ln) => {
    const r = ws.addRow([ln.label]);
    r.getCell(2).value = ln.app;
    r.getCell(3).value = ln.calc;
    r.getCell(2).numFmt = ln.fmt;
    r.getCell(3).numFmt = ln.fmt;
    if (ln.tol !== null) {
      const rn = r.number;
      const appV = typeof ln.app === 'object' && ln.app && 'result' in ln.app ? (ln.app as { result: unknown }).result : null;
      const calcV = typeof ln.calc === 'object' && ln.calc && 'result' in ln.calc ? (ln.calc as { result: unknown }).result : null;
      const ok = typeof appV === 'number' && typeof calcV === 'number' ? Math.abs(appV - calcV) <= ln.tol
        : (appV === null || appV === undefined) && (calcV === '' || calcV === null);
      r.getCell(4).value = {
        formula: `IF(AND(B${rn}="",C${rn}=""),"✔ 일치",IFERROR(IF(ABS(B${rn}-C${rn})<=${ln.tol},"✔ 일치","✖ 불일치"),"✖ 불일치"))`,
        result: ok ? '✔ 일치' : '✖ 불일치',
      };
      if (!ok) sumBad++;
    } else {
      r.getCell(4).value = '참고';
    }
    r.getCell(6).value = ln.how;
    ws.mergeCells(r.number, 4, r.number, 5);
    ws.mergeCells(r.number, 6, r.number, 12);
    wrap(r);
    r.getCell(1).font = { bold: true };
  });
  const sumLast = ws.rowCount;
  ws.addRow([]);

  /* ---------- D. 원재료별 검산 ---------- */
  sectionRow(ws, 'D. 원재료별 검산 — 한 줄씩 다시 계산', 17);
  headRow(ws, [
    '원재료', '원재료key',
    '표준소요 앱(kg)', '근거 재계산(kg)', '판정①',
    '실투입(kg)', '수율 앱', '수율 재계산', '판정②',
    'LOSS 앱(kg)', 'LOSS 재계산', '판정③',
    '단가(원/kg)', 'LOSS금액 앱', 'LOSS금액 재계산', '판정④', '종합',
  ]);
  const detFirst = ws.rowCount + 1;
  let detBad = 0;
  ctx.rows.forEach((row, i) => {
    const dr = first + i;
    const r = ws.addRow([row.name, row.key]);
    const rn = r.number;
    const evid = ctx.contribs.filter((x) => x.key === row.key).reduce((a, x) => a + x.grams, 0) / 1000;
    const std = row.stdG / 1000;
    const act = row.hasInput ? row.actG / 1000 : null;
    const lossKg = row.lossG === null ? null : row.lossG / 1000;
    const pk = row.pricePerG * 1000;
    const blankOr = (ref: string) => `IF(ISBLANK(${ref}),"",${ref})`;
    const ok = (b: boolean) => (b ? '✔' : '✖');
    const yCalc = evid > 0 && act !== null && act > 0 ? evid / act : null;
    const lCalc = act !== null && act > 0 && evid > 0 ? act - evid : null;
    const aCalc = lCalc === null ? null : lCalc * pk;

    r.getCell(3).value = { formula: `${D}!${c.s}${dr}`, result: std };
    r.getCell(4).value = { formula: `SUMIF(${E}!A:A,B${rn},${E}!J:J)`, result: evid };
    r.getCell(5).value = { formula: `IF(ABS(C${rn}-D${rn})<0.001,"✔","✖")`, result: ok(Math.abs(std - evid) < 0.001) };
    r.getCell(6).value = { formula: blankOr(`${D}!${c.a}${dr}`), result: act ?? '' };
    r.getCell(7).value = { formula: blankOr(`${D}!${c.y}${dr}`), result: row.yield ?? '' };
    r.getCell(8).value = { formula: `IF(AND(N(D${rn})>0,N(F${rn})>0),D${rn}/F${rn},"")`, result: yCalc ?? '' };
    r.getCell(9).value = {
      formula: `IF(AND(G${rn}="",H${rn}=""),"—",IFERROR(IF(ABS(G${rn}-H${rn})<0.0005,"✔","✖"),"✖"))`,
      result: row.yield === null && yCalc === null ? '—'
        : row.yield !== null && yCalc !== null && Math.abs(row.yield - yCalc) < 0.0005 ? '✔' : '✖',
    };
    r.getCell(10).value = { formula: blankOr(`${D}!${c.l}${dr}`), result: lossKg ?? '' };
    r.getCell(11).value = { formula: `IF(H${rn}="","",F${rn}-D${rn})`, result: lCalc ?? '' };
    r.getCell(12).value = {
      formula: `IF(AND(J${rn}="",K${rn}=""),"—",IFERROR(IF(ABS(J${rn}-K${rn})<0.001,"✔","✖"),"✖"))`,
      result: lossKg === null && lCalc === null ? '—'
        : lossKg !== null && lCalc !== null && Math.abs(lossKg - lCalc) < 0.001 ? '✔' : '✖',
    };
    r.getCell(13).value = { formula: `N(${D}!${c.pk}${dr})`, result: pk };
    r.getCell(14).value = { formula: blankOr(`${D}!${c.la}${dr}`), result: row.lossAmt === null ? '' : Math.round(row.lossAmt) };
    r.getCell(15).value = { formula: `IF(K${rn}="","",K${rn}*M${rn})`, result: aCalc ?? '' };
    r.getCell(16).value = {
      formula: `IF(AND(N${rn}="",O${rn}=""),"—",IFERROR(IF(ABS(N${rn}-O${rn})<=1,"✔","✖"),"✖"))`,
      result: row.lossAmt === null && aCalc === null ? '—'
        : row.lossAmt !== null && aCalc !== null && Math.abs(Math.round(row.lossAmt) - aCalc) <= 1 ? '✔' : '✖',
    };
    const anyBad = [5, 9, 12, 16].some((k) => {
      const v = r.getCell(k).value as { result?: unknown };
      return v && v.result === '✖';
    });
    if (anyBad) detBad++;
    r.getCell(17).value = { formula: `IF(COUNTIF(E${rn}:P${rn},"✖")>0,"✖ 확인","✔")`, result: anyBad ? '✖ 확인' : '✔' };
    [3, 4, 6, 10, 11].forEach((k) => { r.getCell(k).numFmt = '#,##0.000'; });
    [7, 8].forEach((k) => { r.getCell(k).numFmt = '0.0%'; });
    [13, 14, 15].forEach((k) => { r.getCell(k).numFmt = '#,##0'; });
  });
  const detLast = ws.rowCount;

  // 판정 칸 색 — 조건부 서식이라 근거 시트를 고치면 색도 따라 바뀐다
  const addOkBad = (ref: string) => {
    ws.addConditionalFormatting({
      ref,
      rules: [
        { type: 'containsText', operator: 'containsText', text: '✖', priority: 1,
          style: { fill: { type: 'pattern', pattern: 'solid', bgColor: { argb: BAD_FILL } }, font: { bold: true, color: { argb: 'FFC00000' } } } },
        { type: 'containsText', operator: 'containsText', text: '✔', priority: 2,
          style: { fill: { type: 'pattern', pattern: 'solid', bgColor: { argb: OK_FILL } }, font: { color: { argb: 'FF375623' } } } },
      ],
    });
  };
  if (N > 0) addOkBad(`E${detFirst}:Q${detLast}`);
  addOkBad(`D${sumFirst}:D${sumLast}`);

  // A. 종합 판정 — 계산 검산(C·D)과 데이터 상태(B)를 따로 알려 준다
  const vr = ws.getRow(verdictRowNo);
  const detRange = N > 0 ? `Q${detFirst}:Q${detLast}` : 'Q1:Q1';
  vr.getCell(2).value = {
    formula: `IF(COUNTIF(D${sumFirst}:D${sumLast},"✖*")+COUNTIF(${detRange},"✖*")=0,"✔ 계산은 맞습니다","✖ 계산 불일치 "&(COUNTIF(D${sumFirst}:D${sumLast},"✖*")+COUNTIF(${detRange},"✖*"))&"건 — 아래 C·D 에서 빨간 칸 확인")`,
    result: sumBad + detBad === 0 ? '✔ 계산은 맞습니다' : `✖ 계산 불일치 ${sumBad + detBad}건 — 아래 C·D 에서 빨간 칸 확인`,
  };
  ws.mergeCells(verdictRowNo, 2, verdictRowNo, 6);
  vr.getCell(7).value = {
    formula: `IF(COUNTIF(C${checkFirst}:C${checkLast},"✖*")>0,"✖ 데이터 문제 "&COUNTIF(C${checkFirst}:C${checkLast},"✖*")&"건",IF(COUNTIF(C${checkFirst}:C${checkLast},"△*")>0,"△ 데이터 확인 "&COUNTIF(C${checkFirst}:C${checkLast},"△*")&"건","✔ 데이터 정상"))`,
    result: (() => {
      const bad = checks.filter((x) => x.level === 'bad').length;
      const warn = checks.filter((x) => x.level === 'warn').length;
      return bad > 0 ? `✖ 데이터 문제 ${bad}건` : warn > 0 ? `△ 데이터 확인 ${warn}건` : '✔ 데이터 정상';
    })(),
  };
  ws.mergeCells(verdictRowNo, 7, verdictRowNo, 12);
  addOkBad(`B${verdictRowNo}:L${verdictRowNo}`);
  ws.addConditionalFormatting({
    ref: `G${verdictRowNo}:L${verdictRowNo}`,
    rules: [{ type: 'containsText', operator: 'containsText', text: '△', priority: 3,
      style: { fill: { type: 'pattern', pattern: 'solid', bgColor: { argb: WARN_FILL } } } }],
  });

  ws.addRow([]);

  /* ---------- E. 손으로 검증하는 방법 ---------- */
  sectionRow(ws, 'E. 손으로 검증하는 방법 (원재료 하나 골라서 끝까지 따라가기)', 12);
  [
    ['1단계 · 원재료 고르기', 'LOSS 금액이 큰 원재료 하나를 고릅니다 (예: 새우). 위 D 표에서 그 원재료key 를 확인.'],
    ['2단계 · 근거 보기', '「표준소요 근거」 시트에서 원재료key 로 필터 → 어느 제품에 몇 g 씩 들어갔는지 나옵니다.'],
    ['3단계 · 생산량 대조', '근거 시트의 제품별 생산량(EA)을 앱 분석 › 월별현황(또는 제품검색)의 그 달 생산량과 비교. 다르면 생산 입력/잔여량 문제.'],
    ['4단계 · 레시피 대조', '근거 시트의 개당 g 을 설정 › 레시피(분석용 레시피) 의 그 원재료 g 과 비교. 반제품은 원물까지 풀어서 곱해진 값입니다.'],
    ['5단계 · 실투입 대조', 'ERP 수불부에서 그 달 그 원재료 불출(출고) 합계를 찾아 수율 시트 실제투입(kg)과 비교.'],
    ['6단계 · 단가 대조', '재고평가 단가표의 그 달 단가(원/kg)와 D 표 단가 열 비교.'],
    ['7단계 · 시험해 보기', '근거 시트의 생산량이나 개당g 을 일부러 바꿔 보면 D 표의 판정①이 ✖ 로 바뀝니다 (검증 수식이 실제로 작동한다는 확인). 확인 후에는 저장하지 말고 닫으세요.'],
  ].forEach(([a, b]) => {
    const r = wrap(ws.addRow([a, b]));
    ws.mergeCells(r.number, 2, r.number, 12);
    r.getCell(1).font = { bold: true };
  });
  ws.addRow([]);

  /* ---------- F. 제품별 생산량 ---------- */
  sectionRow(ws, 'F. 제품별 생산량 — 월별현황과 대조용', 12);
  headRow(ws, ['제품코드/제품', '구분', '제품명', '생산량(EA)']);
  const prod = new Map<string, { kind: string; label: string; qty: number }>();
  // 같은 제품은 원재료마다 같은 생산량이 반복되므로 한 번만 센다
  ctx.contribs.forEach((x) => {
    const k = `${x.kind}|${x.product}`;
    const e = prod.get(k);
    if (!e) prod.set(k, { kind: x.kind === 'cold' ? '냉장' : '실온', label: x.label, qty: x.qty });
    else if (x.qty > e.qty) e.qty = x.qty;
  });
  [...prod.entries()]
    .sort((a, b) => a[1].kind.localeCompare(b[1].kind) || b[1].qty - a[1].qty)
    .forEach(([k, v]) => {
      const r = ws.addRow([k.split('|')[1], v.kind, v.label, v.qty]);
      r.getCell(4).numFmt = '#,##0.##';
    });

  ws.views = [{ state: 'frozen', ySplit: 1 }];
  return ws;
}
