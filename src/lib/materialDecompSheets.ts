/** 원재료비 수식 엑셀 — 원가율 분해 시트 (원가율분해 · 원재료별분해 · 제품별구성)
 *
 *  원재료비(ERP 실투입 × 단가)의 증감을 다섯 몫으로 나누고, 원재료비율(÷ 생산금액)의 증감도 같은 몫으로 나눈다.
 *  몫끼리 겹치지 않고, 더하면 실제 증감과 원 단위까지 맞는다 (검산 줄로 확인).
 *
 *  원재료마다  E·F = A·B월 표준소요(레시피 × 생산),  G·H = A·B월 실투입,  M·N = A·B월 단가(원/g)
 *  k = B월 생산량 ÷ A월 생산량,   A월 수율 = E ÷ G
 *    ① 물량      (k − 1) × A월 원재료비
 *    ② 단가      k × Σ G × (N − M)          … A월 단가가 없으면 N 으로 보므로 0
 *    ③ 제품구성  Σ G × (F/E − k) × N        … 생산량 비율보다 표준소요가 더/덜 늘어난 몫 (A월 수율 그대로)
 *    ④ 수율      Σ (H − F × G/E) × N        … 같은 표준소요를 A월 수율로 만들었을 때보다 더/덜 쓴 양
 *    ⑤ 기타      수율을 비교할 수 없는 원재료(실투입 없음·범위 밖·레시피 밖)의 (H − k × G) × N
 *  원재료비율 증감 = ⓐ 개당 생산금액 + (② + ③ + ④ + ⑤) ÷ B월 생산금액
 *    ⓐ = A월 비율 × (k × A월 생산금액 − B월 생산금액) ÷ B월 생산금액
 *       (① 물량은 생산금액도 같이 늘어 비율에서는 상쇄되므로 ⓐ 안으로 들어간다)
 *
 *  ⚠ 수식을 고치면 원재료별 '검산' 열과 원가율분해의 검산 줄이 0 / ✔ 인지 꼭 확인할 것.
 */
import ExcelJS from 'exceljs';

export const DECOMP_SHEET = '원가율분해';
export const MAT_SHEET = '원재료별분해';
export const PROD_SHEET = '제품별구성';

/** 원가율분해 시트의 고정 칸 — 요약·원재료별분해·제품별구성 시트가 참조한다 */
export const DC = {
  amtA: `${DECOMP_SHEET}!$B$6`, amtB: `${DECOMP_SHEET}!$C$6`,
  myA: `${DECOMP_SHEET}!$B$7`, myB: `${DECOMP_SHEET}!$C$7`,
  mode: `${DECOMP_SHEET}!$B$8`,
  lo: `${DECOMP_SHEET}!$B$9`, hi: `${DECOMP_SHEET}!$C$9`,
  k: `${DECOMP_SHEET}!$C$13`,
};
/** 원재료별분해 시트 W열 '표준 1g 당 원가(구성효과용)' — 레시피계산 시트가 INDEX/MATCH 로 읽는다 */
export const MAT_FACTOR_LETTER = 'W';

export interface DecompMaterial {
  key: string;
  code: string;
  name: string;
  category: string;
  /** 정제수처럼 매입이 없어 수율 대상이 아닌 원재료 */
  excluded: boolean;
  actA: number;
  actB: number;
  /** 아래는 정렬용 TS 계산값 (시트 값은 전부 수식) */
  stdA: number;
  stdB: number;
  /** A월 단가가 없으면 B월 단가 */
  pA: number;
  pB: number;
}
export interface DecompProduct {
  key: string;
  name: string;
  kind: string;
  qtyA: number;
  qtyB: number;
  ings: { key: string; gPerPiece: number }[];
}
export interface DecompCtx {
  monthA: string;
  monthB: string;
  recipeLabel: string;
  materials: DecompMaterial[];
  products: DecompProduct[];
  categoryOrder: string[];
  /** 다른 시트 마지막 행 */
  qtyLast: number;
  calcLast: number;
  profitLast: number;
  priceLastExt: number;
  /** 요약 시트 ② 총 생산량 행 번호 */
  sumQtyRow: number;
  aAmount?: number;
  bAmount?: number;
  /** 그 달 실투입이 한 건이라도 있나 */
  hasActualA: boolean;
  hasActualB: boolean;
}

const LO = 0.2;
const HI = 2.0;

/** 상태 문구 — 시트 수식과 TS 정렬 계산이 같은 문자열을 쓴다 */
function statusLabels(monthA: string, monthB: string) {
  return {
    ok: '정상',
    bUnused: `${monthB}엔 안 씀`,
    aUnused: `${monthA}엔 안 씀`,
    noUse: '사용 없음',
    outside: '레시피 밖',
    bNoAct: `${monthB} 실투입 없음`,
    bNoStd: `${monthB} 표준 없음`,
    bOut: `${monthB} 수율 범위 밖`,
    aNoAct: `${monthA} 실투입 없음`,
    aNoStd: `${monthA} 표준 없음`,
    aOut: `${monthA} 수율 범위 밖`,
    excl: '제외(정제수 등)',
  };
}

/** 시트 수식과 같은 규칙의 TS 계산 — 행 정렬(큰 것부터)에만 쓴다 */
function tsEffects(m: DecompMaterial, k: number, ST: ReturnType<typeof statusLabels>) {
  const { stdA: E, stdB: F, actA: G, actB: H, pA: M, pB: N } = m;
  const inR = (v: number) => v >= LO && v <= HI;
  const yA = E > 0 && G > 0 ? E / G : null;
  const yB = F > 0 && H > 0 ? F / H : null;
  const aOK = yA !== null && inR(yA);
  const bOK = yB !== null && inR(yB);
  let st: string;
  if (m.excluded) st = ST.excl;
  else if (E === 0 && F === 0) st = G === 0 && H === 0 ? ST.noUse : ST.outside;
  else if (aOK) st = bOK ? ST.ok : (F === 0 && H === 0 ? ST.bUnused : H === 0 ? ST.bNoAct : F === 0 ? ST.bNoStd : ST.bOut);
  else if (E === 0 && G === 0) st = bOK ? ST.aUnused : (H === 0 ? ST.bNoAct : ST.bOut);
  else st = G === 0 ? ST.aNoAct : E === 0 ? ST.aNoStd : ST.aOut;
  const okL = st === ST.ok || st === ST.bUnused;
  const mix = okL ? G * (F / E - k) * N : st === ST.aUnused ? H * N : 0;
  const yld = st === ST.ok ? (H - (F * G) / E) * N : 0;
  const other = okL || st === ST.aUnused ? 0 : (H - k * G) * N;
  const price = k * G * (N - M);
  const factor = okL ? (N * G) / E : st === ST.aUnused ? (F > 0 ? (N * H) / F : 0) : 0;
  return { st, mix, yld, other, price, factor };
}

export function addDecompSheets(wb: ExcelJS.Workbook, ctx: DecompCtx): void {
  const { monthA, monthB } = ctx;
  const ST = statusLabels(monthA, monthB);

  const HEAD = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10 };
  const headFill = (argb: string) => ({ type: 'pattern' as const, pattern: 'solid' as const, fgColor: { argb } });
  const INPUT_FILL = { type: 'pattern' as const, pattern: 'solid' as const, fgColor: { argb: 'FFFFF2CC' } };
  const thin = { style: 'thin' as const, color: { argb: 'FFD0D0D0' } };
  const BORDER = { top: thin, left: thin, bottom: thin, right: thin };
  const NOTE = { size: 9, color: { argb: 'FF606060' } };
  const WON = '#,##0';
  const PP = '+0.00%"p";-0.00%"p";0.00%"p"';
  const PCT = '0.0%';
  /** 부호 붙인 문자열. TEXT(x,"+#,##0;-#,##0") 는 엔진에 따라 부호가 겹쳐 보여서(--1,217) 부호는 IF 로 직접 붙인다 */
  const sTxt = (x: string, fmt: string) => `IF(N(${x})>0,"+",IF(N(${x})<0,"-",""))&TEXT(ABS(N(${x})),"${fmt}")`;
  const styleHeader = (ws: ExcelJS.Worksheet, row: number, argb: string) => {
    const r = ws.getRow(row);
    r.eachCell((c) => { c.font = HEAD; c.fill = headFill(argb); c.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true }; c.border = BORDER; });
    r.height = 30;
  };

  // ── 정렬용 TS 계산 ──
  const QA = ctx.products.reduce((s, p) => s + p.qtyA, 0);
  const QB = ctx.products.reduce((s, p) => s + p.qtyB, 0);
  const kTs = QA > 0 ? QB / QA : 0;
  const eff = new Map(ctx.materials.map((m) => [m.key, tsEffects(m, kTs, ST)]));
  const mats = [...ctx.materials].sort((a, b) => {
    const x = eff.get(a.key)!, y = eff.get(b.key)!;
    const w = (e: typeof x) => Math.abs(e.mix) + Math.abs(e.yld) + Math.abs(e.other) + Math.abs(e.price);
    return w(y) - w(x) || a.name.localeCompare(b.name);
  });
  const costPerEa = (p: DecompProduct) => p.ings.reduce((s, ing) => s + ing.gPerPiece * (eff.get(ing.key)?.factor || 0), 0);
  const cbarTs = QA > 0 ? ctx.products.reduce((s, p) => s + p.qtyA * costPerEa(p), 0) / QA : 0;
  const prods = [...ctx.products].sort((a, b) => {
    const e = (p: DecompProduct) => Math.abs((p.qtyB - kTs * p.qtyA) * (costPerEa(p) - cbarTs));
    return e(b) - e(a) || a.name.localeCompare(b.name);
  });

  const dLast = Math.max(2, mats.length + 1);
  const P0 = 5;                                   // 제품별구성 데이터 시작 행
  const pLast = Math.max(P0, P0 + prods.length - 1);
  const kk = `N(${DC.k})`;
  // 조회는 전부 INDEX/MATCH 로 '필요한 열 하나'만 본다. VLOOKUP(A:Q) 처럼 넓은 범위를 잡으면 Excel 이 범위 안
  // 모든 칸을 선행으로 보므로, 단가 N·O열 → 원재료집계 → 레시피계산 → 이 시트로 순환참조 경고가 뜰 수 있다.
  const priceCol = (col: string, R: number) =>
    `INDEX(단가!$${col}$2:$${col}$${ctx.priceLastExt},MATCH($A${R},단가!$A$2:$A$${ctx.priceLastExt},0))`;
  const qtyCol = (col: string, R: number) =>
    `INDEX(생산량!$${col}$2:$${col}$${ctx.qtyLast},MATCH($A${R},생산량!$A$2:$A$${ctx.qtyLast},0))`;
  const MR = (col: string) => `${MAT_SHEET}!$${col}$2:$${col}$${dLast}`;
  const PR = (col: string) => `${PROD_SHEET}!$${col}$${P0}:$${col}$${pLast}`;

  /* ================= 원재료별분해 ================= */
  const wsM = wb.addWorksheet(MAT_SHEET);
  wsM.columns = [
    { header: '원재료키', width: 14 },
    { header: 'ERP코드', width: 12 },
    { header: '원재료명', width: 26 },
    { header: '분류', width: 12 },
    { header: `${monthA} 표준소요(g)`, width: 14 },
    { header: `${monthB} 표준소요(g)`, width: 14 },
    { header: `${monthA} 실투입(g) ←입력`, width: 14 },
    { header: `${monthB} 실투입(g) ←입력`, width: 14 },
    { header: `${monthA} 수율`, width: 10 },
    { header: `${monthB} 수율`, width: 10 },
    { header: '수율 증감', width: 10 },
    { header: '상태', width: 16 },
    { header: `${monthA} 단가(원/g)`, width: 11 },
    { header: `${monthB} 단가(원/g)`, width: 11 },
    { header: `${monthA} 원재료비`, width: 14 },
    { header: `${monthB} 원재료비`, width: 14 },
    { header: '① 물량', width: 13 },
    { header: '② 단가', width: 13 },
    { header: '③ 제품구성', width: 13 },
    { header: '④ 수율', width: 13 },
    { header: '⑤ 기타', width: 13 },
    { header: '검산 (0이면 정상)', width: 10 },
    { header: '표준 1g당 원가 (구성효과용)', width: 13 },
    { header: '수율로 더(+)/덜(−) 쓴 양 (kg)', width: 13 },
    { header: `${monthA} 단가 출처`, width: 16 },
    { header: '수율 유리 순위', width: 9 },
    { header: '수율 불리 순위', width: 9 },
  ];
  styleHeader(wsM, 1, 'FF833C0B');
  mats.forEach((m, i) => {
    const R = i + 2;
    const c = (col: string) => `$${col}${R}`;
    const aOK = `AND(ISNUMBER(${c('I')}),N(${c('I')})>=${DC.lo},N(${c('I')})<=${DC.hi})`;
    const bOK = `AND(ISNUMBER(${c('J')}),N(${c('J')})>=${DC.lo},N(${c('J')})<=${DC.hi})`;
    const E = `N(${c('E')})`, F = `N(${c('F')})`, G = `N(${c('G')})`, H = `N(${c('H')})`;
    const status = m.excluded
      ? ST.excl
      : { formula: `IF(AND(${E}=0,${F}=0),IF(AND(${G}=0,${H}=0),"${ST.noUse}","${ST.outside}"),`
        + `IF(${aOK},IF(${bOK},"${ST.ok}",IF(AND(${F}=0,${H}=0),"${ST.bUnused}",IF(${H}=0,"${ST.bNoAct}",IF(${F}=0,"${ST.bNoStd}","${ST.bOut}")))),`
        + `IF(AND(${E}=0,${G}=0),IF(${bOK},"${ST.aUnused}",IF(${H}=0,"${ST.bNoAct}","${ST.bOut}")),`
        + `IF(${G}=0,"${ST.aNoAct}",IF(${E}=0,"${ST.aNoStd}","${ST.aOut}")))))` };
    const okL = `OR(${c('L')}="${ST.ok}",${c('L')}="${ST.bUnused}")`;
    const isNew = `${c('L')}="${ST.aUnused}"`;
    const FperE = `IF(${E}=0,0,${F}/${c('E')})`;
    const row = wsM.addRow([
      m.key, m.code, m.name, m.category,
      { formula: `SUMIF(레시피계산!$D$2:$D$${ctx.calcLast},$A${R},레시피계산!$I$2:$I$${ctx.calcLast})` },
      { formula: `SUMIF(레시피계산!$D$2:$D$${ctx.calcLast},$A${R},레시피계산!$J$2:$J$${ctx.calcLast})` },
      m.actA, m.actB,
      { formula: `IF(AND(${E}>0,${G}>0),${c('E')}/${c('G')},"")` },
      { formula: `IF(AND(${F}>0,${H}>0),${c('F')}/${c('H')},"")` },
      { formula: `IF(AND(ISNUMBER(${c('I')}),ISNUMBER(${c('J')})),${c('J')}-${c('I')},"")` },
      status,
      { formula: `IFERROR(${priceCol('P', R)},0)` },
      { formula: `N(IFERROR(${priceCol('E', R)},0))` },
      { formula: `${G}*${c('M')}` },
      { formula: `${H}*${c('N')}` },
      { formula: `(${kk}-1)*${c('O')}` },
      { formula: `${kk}*${G}*(${c('N')}-${c('M')})` },
      { formula: `IF(${okL},${G}*(${FperE}-${kk})*${c('N')},IF(${isNew},${H}*${c('N')},0))` },
      { formula: `IF(${c('L')}="${ST.ok}",(${H}-${FperE}*${G})*${c('N')},0)` },
      { formula: `IF(OR(${okL},${isNew}),0,(${H}-${kk}*${G})*${c('N')})` },
      { formula: `(${c('P')}-${c('O')})-(${c('Q')}+${c('R')}+${c('S')}+${c('T')}+${c('U')})` },
      { formula: `IF(${okL},IF(${E}=0,0,${c('N')}*${G}/${c('E')}),IF(${isNew},IF(${F}=0,0,${c('N')}*${H}/${c('F')}),0))` },
      { formula: `IF(${c('L')}="${ST.ok}",(${H}-${FperE}*${G})/1000,"")` },
      { formula: `IFERROR(${priceCol('Q', R)},"")` },
      { formula: `IF(N(${c('T')})<0,RANK(${c('T')},$T$2:$T$${dLast},1)+COUNTIF($T$2:$T${R},${c('T')})-1,"")` },
      { formula: `IF(N(${c('T')})>0,RANK(${c('T')},$T$2:$T$${dLast},0)+COUNTIF($T$2:$T${R},${c('T')})-1,"")` },
    ]);
    [5, 6, 7, 8].forEach((x) => { row.getCell(x).numFmt = WON; });
    [7, 8].forEach((x) => { row.getCell(x).fill = INPUT_FILL; });
    [9, 10].forEach((x) => { row.getCell(x).numFmt = PCT; });
    row.getCell(11).numFmt = PP;
    [13, 14].forEach((x) => { row.getCell(x).numFmt = '#,##0.000'; });
    [15, 16, 17, 18, 19, 20, 21, 22].forEach((x) => { row.getCell(x).numFmt = WON; });
    row.getCell(23).numFmt = '#,##0.000';
    row.getCell(24).numFmt = '+#,##0.0;-#,##0.0;0';
    [12, 25, 26, 27].forEach((x) => { row.getCell(x).alignment = { horizontal: 'center' }; });
    row.getCell(20).font = { bold: true };
    [17, 18, 22, 23, 26, 27].forEach((x) => { row.getCell(x).font = { size: 9, color: { argb: 'FF808080' } }; });
  });
  wsM.views = [{ state: 'frozen', xSplit: 3, ySplit: 1 }];
  if (mats.length > 0) wsM.autoFilter = { from: 'A1', to: `AA${dLast}` };

  /* ================= 제품별구성 ================= */
  const wsP = wb.addWorksheet(PROD_SHEET);
  wsP.columns = [
    { width: 16 }, { width: 30 }, { width: 7 }, { width: 8 }, { width: 13 }, { width: 13 }, { width: 14 },
    { width: 13 }, { width: 13 }, { width: 13 }, { width: 14 }, { width: 9 }, { width: 8 }, { width: 8 },
  ];
  wsP.getCell('A1').value = '제품별 구성효과 — 무엇을 더 / 덜 만들어서 원재료비가 움직였나';
  wsP.getCell('A1').font = { bold: true, size: 13, color: { argb: 'FF1F4E79' } };
  wsP.getCell('A2').value = `${monthA} 평균 개당 원재료비 (기준선)`;
  wsP.getCell('A2').font = { bold: true };
  wsP.getCell('C2').value = { formula: `IF(N(SUM(${PR('E')}))=0,"",SUMPRODUCT(${PR('E')},${PR('I')})/SUM(${PR('E')}))` };
  wsP.getCell('C2').numFmt = '#,##0.0';
  wsP.getCell('C2').font = { bold: true, color: { argb: 'FFC00000' } };
  wsP.mergeCells('D2:N2');
  wsP.getCell('D2').value = '개당 원재료비(I열)가 이 기준선보다 비싼 제품을 생산량 비율보다 더 만들면 원재료비가 오르고(+), 싼 제품을 더 만들면 내려갑니다(−).';
  wsP.getCell('D2').font = NOTE;
  wsP.mergeCells('A3:N3');
  wsP.getCell('A3').value = `개당 원재료비 = 레시피 × ${monthB} 단가 ÷ ${monthA} 수율 (수율을 비교할 수 있는 원재료만). 구성효과 = (실제 생산 − 생산량 비율대로 늘었을 때) × (개당 원재료비 − 기준선). 합계는 원가율분해 ③ 과 같습니다.`;
  wsP.getCell('A3').font = NOTE;
  wsP.getCell('A3').alignment = { wrapText: true, vertical: 'top' };
  wsP.getRow(3).height = 28;
  const pHdr = ['품목코드', '품목명', '구분', '레시피', `${monthA} 생산(EA)`, `${monthB} 생산(EA)`, '생산량 비율대로였다면', '그보다 더(+)/덜(−) (EA)',
    '개당 원재료비 (원/EA)', '기준선 대비 (원/EA)', '구성효과 (원)', '고단가 포함', '유리 순위', '불리 순위'];
  pHdr.forEach((h, i) => { wsP.getRow(P0 - 1).getCell(i + 1).value = h; });
  styleHeader(wsP, P0 - 1, 'FF375623');
  prods.forEach((p, i) => {
    const R = P0 + i;
    const c = (col: string) => `$${col}${R}`;
    const row = wsP.getRow(R);
    row.values = [
      p.key, p.name, p.kind,
      { formula: `IFERROR(${qtyCol('F', R)},"")` },
      { formula: `IFERROR(${qtyCol('D', R)},0)` },
      { formula: `IFERROR(${qtyCol('E', R)},0)` },
      { formula: `N(${c('E')})*${kk}` },
      { formula: `N(${c('F')})-${c('G')}` },
      { formula: `SUMIF(레시피계산!$A$2:$A$${ctx.calcLast},$A${R},레시피계산!$P$2:$P$${ctx.calcLast})` },
      { formula: `${c('I')}-N($C$2)` },
      { formula: `${c('H')}*${c('J')}` },
      { formula: `IFERROR(${qtyCol('G', R)},"")` },
      { formula: `IF(${c('K')}<0,RANK(${c('K')},$K$${P0}:$K$${pLast},1)+COUNTIF($K$${P0}:$K${R},${c('K')})-1,"")` },
      { formula: `IF(${c('K')}>0,RANK(${c('K')},$K$${P0}:$K$${pLast},0)+COUNTIF($K$${P0}:$K${R},${c('K')})-1,"")` },
    ];
    [5, 6, 7, 8].forEach((x) => { row.getCell(x).numFmt = '#,##0'; });
    [9, 10].forEach((x) => { row.getCell(x).numFmt = '#,##0.0'; });
    row.getCell(10).numFmt = '+#,##0.0;-#,##0.0;0';
    row.getCell(11).numFmt = '+#,##0;-#,##0;0';
    row.getCell(11).font = { bold: true };
    [3, 4, 12, 13, 14].forEach((x) => { row.getCell(x).alignment = { horizontal: 'center' }; });
    [13, 14].forEach((x) => { row.getCell(x).font = { size: 9, color: { argb: 'FF808080' } }; });
  });
  wsP.views = [{ state: 'frozen', xSplit: 2, ySplit: P0 - 1 }];
  if (prods.length > 0) wsP.autoFilter = { from: `A${P0 - 1}`, to: `N${pLast}` };

  /* ================= 원가율분해 (첫 탭) ================= */
  const ws = wb.getWorksheet(DECOMP_SHEET)!;
  ws.columns = [{ width: 38 }, { width: 17 }, { width: 17 }, { width: 17 }, { width: 17 }, { width: 17 }, { width: 17 }, { width: 17 }];
  const cell = (r: number, c: number) => ws.getRow(r).getCell(c);
  const f = (r: number, c: number, formula: string, fmt?: string, bold = false) => {
    const x = cell(r, c);
    x.value = { formula };
    if (fmt) x.numFmt = fmt;
    x.border = BORDER;
    if (bold) x.font = { bold: true };
    return x;
  };
  const label = (r: number, text: string, opts: { bold?: boolean; indent?: boolean } = {}) => {
    const x = cell(r, 1);
    x.value = text;
    x.font = { bold: opts.bold ?? !opts.indent, size: 10, color: opts.indent ? { argb: 'FF404040' } : undefined };
    x.border = BORDER;
  };
  const note = (r: number, c1: number, v: string | { formula: string }, height?: number) => {
    ws.mergeCells(r, c1, r, 8);
    const x = cell(r, c1);
    x.value = v;
    x.font = NOTE;
    x.alignment = { wrapText: true, vertical: 'middle' };
    if (height) ws.getRow(r).height = height;
  };
  const header = (r: number, cols: string[], argb: string, noteFrom: number) => {
    cols.forEach((h, i) => { cell(r, i + 1).value = h; });
    if (noteFrom <= 8) {
      ws.mergeCells(r, noteFrom, r, 8);
    }
    styleHeader(ws, r, argb);
  };
  const input = (r: number, c: number, v: ExcelJS.CellValue, fmt?: string) => {
    const x = cell(r, c);
    x.value = v;
    x.fill = INPUT_FILL;
    x.border = BORDER;
    if (fmt) x.numFmt = fmt;
    x.alignment = { horizontal: 'right' };
    return x;
  };

  // 1~4 제목
  ws.mergeCells(1, 1, 1, 8);
  cell(1, 1).value = '원재료비율 분해 — 수율 · 제품 구성 · 단가가 원가율을 얼마나 움직였나';
  cell(1, 1).font = { bold: true, size: 16, color: { argb: 'FF1F4E79' } };
  ws.getRow(1).height = 26;
  ws.mergeCells(2, 1, 2, 8);
  cell(2, 1).value = `${monthA} → ${monthB}   ·   레시피: ${ctx.recipeLabel}   ·   원재료비 = ERP 실투입 × 재고평가 단가   ·   노란칸만 넣으면 아래가 전부 자동 계산됩니다`;
  cell(2, 1).font = NOTE;
  ws.mergeCells(3, 1, 3, 8);
  cell(3, 1).value = '⚠ 값이 0 이나 빈칸으로 보이면 상단의 [편집 사용]을 누르세요. 보호된 보기에서는 수식이 계산되지 않습니다.';
  cell(3, 1).font = { bold: true, size: 10, color: { argb: 'FF9C4221' } };
  cell(3, 1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF3CD' } };

  // 5~9 입력
  header(5, ['입력 (노란칸)', monthA, monthB, '설명'], 'FF1F4E79', 4);
  label(6, '생산금액 (원)  ← 직접 입력');
  input(6, 2, ctx.aAmount && ctx.aAmount > 0 ? ctx.aAmount : null, WON);
  input(6, 3, ctx.bAmount && ctx.bAmount > 0 ? ctx.bAmount : null, WON);
  note(6, 4, '원재료비율의 분모. ERP 월 생산금액을 넣으세요 — 요약 시트 ① 도 이 칸을 씁니다.');
  label(7, '내 원재료비 (원)  ← 선택');
  input(7, 2, null, WON);
  input(7, 3, null, WON);
  note(7, 4, '따로 계산해 둔 원재료비가 있으면 넣으세요. 아래 「계산값」과 바로 비교되고, 요약 시트 ⑦ 로도 들어갑니다.');
  label(8, `${monthA} 원재료비로 쓸 값  ← 선택`);
  input(8, 2, '계산값').dataValidation = {
    type: 'list', allowBlank: false, showErrorMessage: true, formulae: ['"계산값,내 숫자"'],
  };
  cell(8, 2).alignment = { horizontal: 'center' };
  note(8, 3, `계산값 = 실투입 × 단가. ${monthA} 단가가 없으면 「내 숫자」를 고르세요 — ${monthA} 원재료비 총액으로 단가 효과를 역산합니다 (내 숫자가 실투입 DB 와 같은 원재료 범위일 때만 정확).`, 30);
  label(9, '수율 정상 범위 (하한 / 상한)');
  input(9, 2, LO, '0%');
  input(9, 3, HI, '0%');
  note(9, 4, '이 범위 밖 수율은 데이터 이상으로 보고 ⑤ 기타로 뺍니다 (원재료수율 화면과 같은 기준 20~200%).');

  // 11~25 기본 숫자
  header(11, ['기본 숫자', monthA, monthB, '증감', '설명'], 'FF2E75B6', 5);
  const dRow = (r: number, fmt: string) => f(r, 4, `IF(OR(B${r}="",C${r}=""),"",C${r}-B${r})`, fmt);
  label(12, '생산량 (EA)');
  f(12, 2, `요약!B${ctx.sumQtyRow}`, WON); f(12, 3, `요약!C${ctx.sumQtyRow}`, WON); dRow(12, '+#,##0;-#,##0;0');
  note(12, 5, '요약 시트 ② — 냉장 + 실온 전체');
  label(13, '생산 증가 배수 k (B ÷ A)');
  f(13, 3, 'IF(N(B12)=0,"",C12/B12)', '0.0000');
  note(13, 5, '"생산량대로만 늘었다면" 의 기준. 아래 ① 물량·③ 제품구성이 이 값을 씁니다.');
  label(14, '원재료비 — 계산 (실투입 × 단가)');
  f(14, 2, `SUM(${MR('O')})`, WON); f(14, 3, `SUM(${MR('P')})`, WON); dRow(14, '+#,##0;-#,##0;0');
  note(14, 5, `원재료별분해 시트 합계. ${monthA} 단가가 없는 원재료는 ${monthB} 단가로 계산합니다.`);
  label(15, `   └ ${monthA} 실투입 × ${monthB} 단가`, { indent: true });
  f(15, 2, `SUMPRODUCT(${MR('G')},${MR('N')})`, WON);
  note(15, 5, '단가를 같게 놓고 본 A월 원재료비 — 단가 효과의 기준');
  label(16, `   └ ${monthA} 단가가 없어 ${monthB} 단가로 계산한 비중`, { indent: true });
  f(16, 2, `IF(N(B14)=0,"",SUMIF(${MR('Y')},"${monthB} 단가로 대체",${MR('O')})/B14)`, PCT);
  note(16, 5, '100% 면 단가 효과(②)는 0 으로 잡힙니다. 단가 시트 D열에 작년 단가를 넣거나 8행에서 「내 숫자」를 고르면 나옵니다.');
  label(17, '원재료비 — 내 숫자');
  f(17, 2, 'IF(B7="","",B7)', WON); f(17, 3, 'IF(C7="","",C7)', WON); dRow(17, '+#,##0;-#,##0;0');
  label(18, '   └ 차이 (내 숫자 − 계산)', { indent: true });
  f(18, 2, 'IF(B17="","",B17-B14)', '+#,##0;-#,##0;0'); f(18, 3, 'IF(C17="","",C17-C14)', '+#,##0;-#,##0;0');
  note(18, 5, { formula: 'IF(AND(B17="",C17=""),"7행에 내 원재료비를 넣으면 계산값과 비교됩니다.",'
    + `"차이율 "&IF(OR(B17="",N(B14)=0),"-",${sTxt('B18/B14', '0.0%')})&" / "&IF(OR(C17="",N(C14)=0),"-",${sTxt('C18/C14', '0.0%')})`
    + '&IF(OR(AND(B17<>"",N(B14)<>0,ABS(N(B18)/N(B14))>0.02),AND(C17<>"",N(C14)<>0,ABS(N(C18)/N(C14))>0.02))," ⚠ 2% 넘게 차이 — 포함 원재료 범위나 단가 기준이 다른지 보세요"," ✔ 거의 같습니다"))' }, 30);
  label(19, '★ 분해에 쓰는 원재료비');
  f(19, 2, 'IF(AND(B8="내 숫자",N(B7)>0),B7,B14)', WON, true); f(19, 3, 'C14', WON, true); dRow(19, '+#,##0;-#,##0;0');
  note(19, 5, { formula: `IF(AND(B8="내 숫자",N(B7)>0),"${monthA} 은 내 숫자, ${monthB} 은 계산값을 씁니다.","두 달 모두 계산값(실투입 × 단가)을 씁니다.")` });
  label(20, '원재료비율 (원재료비 ÷ 생산금액)');
  f(20, 2, 'IF(N(B6)=0,"",B19/B6)', '0.00%', true); f(20, 3, 'IF(N(C6)=0,"",C19/C6)', '0.00%', true); dRow(20, PP);
  [2, 3].forEach((x) => { cell(20, x).font = { bold: true, size: 12, color: { argb: 'FFC00000' } }; });
  note(20, 5, '6행 생산금액을 넣으면 나옵니다.');
  label(21, '   └ 내 숫자 기준 원재료비율', { indent: true });
  f(21, 2, 'IF(OR(N(B7)=0,N(B6)=0),"",B7/B6)', '0.00%'); f(21, 3, 'IF(OR(N(C7)=0,N(C6)=0),"",C7/C6)', '0.00%'); dRow(21, PP);
  label(22, '개당 원재료비 (원/EA)');
  f(22, 2, 'IF(N(B12)=0,"",B19/B12)', '#,##0.0'); f(22, 3, 'IF(N(C12)=0,"",C19/C12)', '#,##0.0'); dRow(22, '+#,##0.0;-#,##0.0;0');
  label(23, '개당 생산금액 (원/EA)');
  f(23, 2, 'IF(OR(N(B6)=0,N(B12)=0),"",B6/B12)', '#,##0.0'); f(23, 3, 'IF(OR(N(C6)=0,N(C12)=0),"",C6/C12)', '#,##0.0'); dRow(23, '+#,##0.0;-#,##0.0;0');
  note(23, 5, '오르면 원가율이 내려갑니다 (아래 ⓐ). 판가 인상이나 비싼 제품 비중이 늘면 오릅니다.');
  label(24, '공급가 기준 매출 (제품수익성 E열 × 생산량)');
  f(24, 2, `SUM(제품수익성!$M$2:$M$${ctx.profitLast})`, WON); f(24, 3, `SUM(제품수익성!$N$2:$N$${ctx.profitLast})`, WON); dRow(24, '+#,##0;-#,##0;0');
  note(24, 5, '선택. 제품수익성 시트 E열에 공급가를 넣으면 ⓐ 를 「제품 구성」과 「판가·기타」로 나눠 줍니다.');
  label(25, '   └ 공급가를 넣은 제품 비중 (생산량 기준)', { indent: true });
  f(25, 2, `IF(N(B12)=0,"",1-SUM(제품수익성!$AA$2:$AA$${ctx.profitLast})/B12)`, PCT);
  f(25, 3, `IF(N(C12)=0,"",1-SUM(제품수익성!$AB$2:$AB$${ctx.profitLast})/C12)`, PCT);
  note(25, 5, '100% 가까워야 ⓐ-1 을 믿을 수 있습니다.');

  // 27~35 원재료비 증감 분해
  header(27, ['원재료비 증감 분해  (+ 늘어남 · − 줄어듦)', '금액 (원)', '유리 합 (−)', '불리 합 (+)', '원가율 영향', '읽는 법'], 'FFC00000', 6);
  const SG = '+#,##0;-#,##0;0';
  const sumIf = (col: string, sign: '<0' | '>0') => `SUMIF(${MR(col)},"${sign}")`;
  label(28, '① 물량 (많이 · 적게 만들어서)');
  f(28, 2, 'IF(C13="","",(C13-1)*B19)', SG, true);
  cell(28, 5).value = '→ 아래 ⓐ'; cell(28, 5).font = NOTE; cell(28, 5).alignment = { horizontal: 'center' };
  note(28, 6, '많이 만들면 원재료비도 느는 게 정상. 생산금액도 같이 늘어 원가율에는 영향이 없습니다.', 30);
  const pp = (r: number) => f(r, 5, `IF(OR(B${r}="",N($C$6)=0),"",B${r}/$C$6)`, PP);
  label(29, '② 원재료 단가');
  f(29, 2, 'IF(C13="","",C13*(B15-B19))', SG, true);
  f(29, 3, `IF(B8="내 숫자","",${sumIf('R', '<0')})`, SG); f(29, 4, `IF(B8="내 숫자","",${sumIf('R', '>0')})`, SG); pp(29);
  note(29, 6, { formula: `IF(N(B16)>=0.999,"${monthA} 단가가 없어 0 으로 잡혔습니다 (모든 원재료를 ${monthB} 단가로 계산).",IF(B8="내 숫자","${monthA} 원재료비(내 숫자) 로 역산한 값 — 원재료별로는 안 나뉩니다.","원재료를 더 비싸게(+) / 싸게(−) 산 몫. 원재료별분해 R열."))` }, 30);
  label(30, '③ 제품 구성 (원재료 쪽)');
  f(30, 2, `SUM(${MR('S')})`, SG, true); f(30, 3, sumIf('S', '<0'), SG); f(30, 4, sumIf('S', '>0'), SG); pp(30);
  note(30, 6, '원재료가 많이(비싸게) 드는 제품을 생산량 비율보다 더 만들면 +, 덜 드는 제품 위주면 −. 제품별은 「제품별구성」 시트.', 30);
  label(31, '④ 수율');
  f(31, 2, `SUM(${MR('T')})`, SG, true); f(31, 3, sumIf('T', '<0'), SG); f(31, 4, sumIf('T', '>0'), SG); pp(31);
  note(31, 6, `${monthB} 표준소요를 ${monthA} 수율로 만들었을 때보다 덜 쓰면 −(절감), 더 쓰면 +. 금액은 ${monthB} 단가.`, 30);
  label(32, '⑤ 기타 (수율 비교 불가 원재료)');
  f(32, 2, `SUM(${MR('U')})`, SG, true); f(32, 3, sumIf('U', '<0'), SG); f(32, 4, sumIf('U', '>0'), SG); pp(32);
  note(32, 6, '실투입 없음 · 수율 범위 밖 · 레시피 밖 원재료. 크면 원재료별분해 L열(상태)을 보세요.');
  label(33, '합계 (= B월 − A월 원재료비)', { bold: true });
  f(33, 2, 'N(B28)+N(B29)+B30+B31+B32', SG, true);
  pp(33);
  label(34, '검산 (합계 − 실제 증감)', { indent: true });
  f(34, 2, 'B33-(C19-B19)', '#,##0.00');
  note(34, 3, { formula: 'IF(ABS(B34)<1,"✔ 다섯 몫의 합이 실제 증감과 딱 맞습니다.","⚠ 어긋납니다 — 생산량(12행)이 0 인 달이 있는지 보세요.")' });
  label(35, '   └ ③ 을 제품별로 더한 값 (제품별구성 시트)', { indent: true });
  f(35, 2, `SUM(${PR('K')})`, SG);
  note(35, 3, { formula: 'IF(ABS(B35-B30)<1,"✔ ③ 과 같습니다 — 제품별 시트로 원인을 나눠 볼 수 있습니다.","⚠ ③ 과 다릅니다")' });

  // 37~47 원재료비율 분해
  header(37, ['원재료비율 증감 분해', '원가율 영향', '', '', '', '읽는 법'], 'FF7030A0', 6);
  ws.mergeCells(37, 2, 37, 5);
  const ratioRow = (r: number, text: string, formula: string, n: string | { formula: string }, opts: { indent?: boolean; bold?: boolean } = {}) => {
    label(r, text, opts);
    ws.mergeCells(r, 2, r, 5);
    f(r, 2, formula, PP, !opts.indent);
    cell(r, 2).alignment = { horizontal: 'center' };
    note(r, 6, n, 30);
  };
  ratioRow(38, 'ⓐ 개당 생산금액 (판가 · 매출 구성)', 'IF(OR(N(B6)=0,N(C6)=0,C13=""),"",B20*(C13*B6-C6)/C6)',
    '제품 1개당 생산금액이 오르면 −(원가율 내려감). ① 물량은 여기서 생산금액 증가와 상쇄됩니다.');
  ratioRow(39, '   ⓐ-1 그중 제품 구성 (매출 쪽)', 'IF(OR(B38="",N(B24)=0,N(C24)=0),"",B20*(C13*B6-B6*C24/B24)/C6)',
    '비싼 제품을 더 만들어 매출이 오른 몫. 제품수익성 E열에 공급가를 넣어야 나옵니다.', { indent: true });
  ratioRow(40, '   ⓐ-2 그중 판가 · 기타', 'IF(B39="","",B38-B39)', '공급가는 그대로인데 생산금액이 달라진 몫 (판가 인상 · 할인 · 생산금액 기준 차이).', { indent: true });
  ratioRow(41, '② 원재료 단가', 'IF(OR(N(C6)=0,B29=""),"",B29/C6)', '위 ② 금액 ÷ B월 생산금액');
  ratioRow(42, '③ 제품 구성 (원재료 쪽)', 'IF(N(C6)=0,"",B30/C6)', '위 ③ 금액 ÷ B월 생산금액');
  ratioRow(43, '④ 수율', 'IF(N(C6)=0,"",B31/C6)', '위 ④ 금액 ÷ B월 생산금액');
  ratioRow(44, '⑤ 기타', 'IF(N(C6)=0,"",B32/C6)', '위 ⑤ 금액 ÷ B월 생산금액');
  ratioRow(45, '합계 (= 원재료비율 증감)', 'IF(OR(B38="",B41=""),"",B38+B41+B42+B43+B44)',
    { formula: `IF(OR(B45="",D20=""),"6행 생산금액을 두 달 다 넣으면 계산됩니다.",IF(ABS(B45-D20)<0.000001,"✔ 실제 원재료비율 증감("&${sTxt('D20', '0.00%')}&"p)과 딱 맞습니다.","⚠ 실제 증감과 다릅니다"))` }, { bold: true });
  ratioRow(46, '★ 제품 구성 순효과 (③ + ⓐ-1)', 'IF(B39="","",B42+B39)',
    '같은 제품 구성 변화가 원재료비를 올린 만큼 매출도 올렸는지. 이 값이 제품 구성이 원가율에 준 순효과입니다.');
  cell(46, 1).font = { bold: true, color: { argb: 'FF7030A0' } };

  // 48~ 한 줄 요약
  let r = 48;
  ws.mergeCells(r, 1, r, 8);
  cell(r, 1).value = '한 줄 요약';
  styleHeader(ws, r, 'FF375623');
  const won = (x: string) => sTxt(x, '#,##0');
  const ppT = (x: string) => `${sTxt(x, '0.00%')}&"p"`;
  const sentences = [
    `IF(OR(N(B6)=0,N(C6)=0),"6행 생산금액을 두 달 다 넣으면 원재료비율 분해가 나옵니다. (금액 분해는 지금도 아래 표에 있습니다)",`
      + `"원재료비율 "&TEXT(B20,"0.00%")&" → "&TEXT(C20,"0.00%")&" ("&${ppT('D20')}&"). "`
      + `&"수율 "&${ppT('B43')}&" · 제품 구성 "&IF(B46="",${ppT('B42')}&"(원재료 쪽)",${ppT('B46')})&" · 원재료 단가 "&${ppT('B41')}&" · "&IF(B39="","개당 생산금액 "&${ppT('B38')},"판가·기타 "&${ppT('B40')})&" · 기타 "&${ppT('B44')})`,
    `"원재료비 "&TEXT(B19,"#,##0")&" → "&TEXT(C19,"#,##0")&" 원 ("&${won('C19-B19')}&"). 물량 "&${won('N(B28)')}&" · 단가 "&${won('N(B29)')}&" · 제품 구성 "&${won('B30')}&" · 수율 "&${won('B31')}&" · 기타 "&${won('B32')}`,
    `"수율: 좋아진 원재료 "&${won('C31')}&" + 나빠진 원재료 "&${won('D31')}&" = "&${won('B31')}&" 원.  제품 구성: 유리 "&${won('C30')}&" + 불리 "&${won('D30')}&" = "&${won('B30')}&" 원."`,
    `IF(N(B16)>=0.5,"⚠ ${monthA} 단가가 없어 원재료비의 "&TEXT(B16,"0%")&"를 ${monthB} 단가로 계산했습니다 — 단가 효과는 그만큼 0 으로 잡힙니다.",`
      + `IF(AND(N(C19-B19)<>0,ABS(N(B32))>ABS(N(C19-B19))*0.3),"⚠ 기타(수율 비교 불가)가 큽니다 — 원재료별분해 L열에서 실투입 없음·범위 밖 원재료를 확인하세요.",""))`,
  ];
  if (!ctx.hasActualA || !ctx.hasActualB) {
    sentences.unshift(`"⚠ 실투입(설정 › 실제 투입중량)이 ${!ctx.hasActualA ? monthA : ''}${!ctx.hasActualA && !ctx.hasActualB ? ', ' : ''}${!ctx.hasActualB ? monthB : ''} 에 없습니다 — 수율·제품 구성을 나눌 수 없어 대부분 ⑤ 기타로 갑니다."`);
  }
  sentences.forEach((s) => {
    r += 1;
    ws.mergeCells(r, 1, r, 8);
    cell(r, 1).value = { formula: s };
    cell(r, 1).font = { size: 11, color: { argb: 'FF203864' }, bold: r === 49 };
    cell(r, 1).alignment = { wrapText: true, vertical: 'middle' };
    ws.getRow(r).height = 32;
  });

  // 분류별
  const present = new Set(mats.map((m) => m.category).filter(Boolean));
  const cats = [...ctx.categoryOrder.filter((c) => present.has(c)), ...[...present].filter((c) => !ctx.categoryOrder.includes(c)).sort((a, b) => (a === '미분류' ? 1 : b === '미분류' ? -1 : a.localeCompare(b)))];
  if (cats.length > 0) {
    r += 2;
    header(r, ['분류별', '④ 수율 (원)', '③ 제품 구성 (원)', '② 단가 (원)', '⑤ 기타 (원)', `${monthA} 수율`, `${monthB} 수율`, `${monthB} 원재료비`], 'FF833C0B', 9);
    const top = r + 1;
    cats.forEach((cat) => {
      r += 1;
      label(r, cat);
      const si = (col: string) => `SUMIF(${MR('D')},$A${r},${MR(col)})`;
      const sOk = (col: string) => `SUMIFS(${MR(col)},${MR('D')},$A${r},${MR('L')},"${ST.ok}")`;
      f(r, 2, si('T'), SG); f(r, 3, si('S'), SG); f(r, 4, si('R'), SG); f(r, 5, si('U'), SG);
      f(r, 6, `IF(N(${sOk('G')})=0,"",${sOk('E')}/${sOk('G')})`, PCT);
      f(r, 7, `IF(N(${sOk('H')})=0,"",${sOk('F')}/${sOk('H')})`, PCT);
      f(r, 8, si('P'), WON);
    });
    r += 1;
    label(r, '합계', { bold: true });
    [2, 3, 4, 5, 8].forEach((x) => {
      const L = String.fromCharCode(64 + x);
      f(r, x, `SUM(${L}${top}:${L}${r - 1})`, x === 8 ? WON : SG, true);
    });
    r += 1;
    ws.mergeCells(r, 1, r, 8);
    cell(r, 1).value = `수율은 두 달 모두 '정상' 인 원재료만으로 낸 가중 수율(Σ표준 ÷ Σ실투입)입니다. 분류는 설정 › 원재료 분류 기준.`;
    cell(r, 1).font = NOTE;
  }

  // TOP 목록
  const topList = (title: string, argb: string, rankCol: string, kind: 'mat' | 'prod') => {
    r += 2;
    if (kind === 'mat') {
      header(r, ['#  ' + title, '원재료명', '분류', `${monthA} 수율`, `${monthB} 수율`, '수율 증감', '더(+)/덜(−) 쓴 kg', '④ 수율효과 (원)'], argb, 9);
    } else {
      header(r, ['#  ' + title, '품목명', '구분', `${monthA} 생산`, `${monthB} 생산`, '비율보다 더/덜 (EA)', '기준선 대비 (원/EA)', '③ 구성효과 (원)'], argb, 9);
    }
    const N = 10;
    for (let n = 1; n <= N; n += 1) {
      r += 1;
      const rng = kind === 'mat' ? MR : PR;
      const pick = (col: string) => `IFERROR(INDEX(${rng(col)},MATCH(${n},${rng(rankCol)},0)),"")`;
      f(r, 1, `IF(${n}>COUNT(${rng(rankCol)}),"",${n})`);
      cell(r, 1).alignment = { horizontal: 'center' };
      if (kind === 'mat') {
        f(r, 2, pick('C')); f(r, 3, pick('D'));
        f(r, 4, pick('I'), PCT); f(r, 5, pick('J'), PCT); f(r, 6, pick('K'), PP);
        f(r, 7, pick('X'), '+#,##0.0;-#,##0.0;0'); f(r, 8, pick('T'), SG, true);
      } else {
        f(r, 2, pick('B')); f(r, 3, pick('C'));
        f(r, 4, pick('E'), WON); f(r, 5, pick('F'), WON); f(r, 6, pick('H'), '+#,##0;-#,##0;0');
        f(r, 7, pick('J'), '+#,##0.0;-#,##0.0;0'); f(r, 8, pick('K'), SG, true);
      }
    }
  };
  topList('수율이 좋아져 아낀 원재료 TOP 10', 'FF2E7D32', 'Z', 'mat');
  topList('수율이 나빠져 더 쓴 원재료 TOP 10', 'FFC62828', 'AA', 'mat');
  topList('제품 구성 — 원재료비를 줄인 제품 TOP 10', 'FF2E7D32', 'M', 'prod');
  topList('제품 구성 — 원재료비를 늘린 제품 TOP 10', 'FFC62828', 'N', 'prod');

  // 읽는 법
  r += 2;
  [
    '■ 이 시트는 무엇을 하나',
    `  원재료비(실투입 × 단가)가 ${monthA} → ${monthB} 에 왜 변했는지를 ① 물량 ② 단가 ③ 제품 구성 ④ 수율 ⑤ 기타 로 나눕니다. 다섯 몫은 겹치지 않고 더하면 실제 증감과 딱 맞습니다(34행 검산).`,
    '  원재료비율(÷ 생산금액)로 바꾸면 ① 물량은 생산금액도 같이 늘어 사라지고, 대신 ⓐ 개당 생산금액(판가·매출 구성)이 들어옵니다.',
    '■ 계산식 (원재료 한 줄 기준, 금액은 전부 B월 단가)',
    '  ③ 제품 구성 = A월 실투입 × (B월 표준 ÷ A월 표준 − 생산 증가 배수 k) × B월 단가',
    '  ④ 수율      = (B월 실투입 − B월 표준 ÷ A월 수율) × B월 단가        … A월 수율 그대로였다면 필요했을 양과의 차이',
    '  ② 단가      = k × A월 실투입 × (B월 단가 − A월 단가)',
    '  ⓐ          = A월 원재료비율 × (k × A월 생산금액 − B월 생산금액) ÷ B월 생산금액',
    '■ 읽을 때 주의',
    '  · 원재료 수율은 계절을 많이 타므로 성과를 볼 때는 전년 동월끼리 비교하세요. 단, 추석 위치(2025년 10월 · 2026년 9월)처럼 달력이 다르면 월말 투입 이월이 섞일 수 있습니다.',
    '  · 표준소요는 두 달 모두 「지금」 레시피로 계산합니다. 레시피를 고친 효과는 수율로 잡히지 않습니다.',
    '  · 레시피가 없는 제품(생산량 시트 F열 "없음")은 표준소요 0 이라 그 제품 원재료는 ④ 가 아니라 ⑤ 기타·수율 악화로 보일 수 있습니다.',
    `  · 노란칸(실투입 · 단가 · 생산량)을 고치면 전부 다시 계산됩니다. ${monthA} 단가는 단가 시트 D열에 넣으세요.`,
  ].forEach((g) => {
    r += 1;
    ws.mergeCells(r, 1, r, 8);
    cell(r, 1).value = g;
    cell(r, 1).font = g.startsWith('■') ? { bold: true, size: 10, color: { argb: 'FF1F4E79' } } : { size: 9, color: { argb: 'FF404040' } };
    cell(r, 1).alignment = { wrapText: true, vertical: 'top' };
    if (g.length > 90) ws.getRow(r).height = 26;
  });
  ws.views = [{ state: 'frozen', ySplit: 4 }];
}

/** 원재료별분해 시트 마지막 행 — 레시피계산 시트가 INDEX/MATCH 범위로 쓴다 */
export function decompMatLast(count: number): number {
  return Math.max(2, count + 1);
}
