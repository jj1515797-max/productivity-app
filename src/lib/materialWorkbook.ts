/** 원재료비 분석 — 수식이 살아있는 엑셀 워크북 생성
 *
 *  앱이 계산한 "결과값"이 아니라 계산에 쓰인 DB(레시피·단가·생산량)를 그대로 넣고
 *  엑셀 수식으로 다시 계산되게 만든다. 생산개수나 단가를 바꾸면 즉시 재계산된다.
 *
 *  시트 구성
 *   요약        : 생산금액 입력(노란칸) + 원재료비율/개당재료비 결과
 *   생산량      : 품목별 생산개수 (입력·수정 가능)
 *   레시피계산  : 레시피 1줄 = 품목×원재료. 사용량/금액을 수식으로 산출
 *   단가        : 원재료별 월 단가(원/g) + 그룹(고단가 등)
 *   원재료집계  : 원재료별 SUMIF 집계
 */
import ExcelJS from 'exceljs';
import type { AmbientRecipe, Recipe } from './wasteCompute';
import { CODE_KEY_PREFIX, monthPriceKey, normalizeCode, normalizeMaterialName } from './wasteCompute';
import { canonicalShort } from './codeUtil';
import type { MonthlyProduction } from './monthlyProduction';

export interface WorkbookInput {
  monthA: string;
  monthB: string;
  aProd: MonthlyProduction;
  bProd: MonthlyProduction;
  /** canonicalShort 코드 → 제품명 */
  productNameByCode: Map<string, string>;
  /** 반제품 펼침이 적용된 최종 레시피 맵 */
  recipeMap: Map<string, Recipe>;
  ambientRecipeMap: Map<string, AmbientRecipe>;
  /** `${month}|${key}` → 원/g */
  priceMap: Map<string, number>;
  /** ERP코드 → 단가표상 정식명 */
  priceNameByCode: Map<string, string>;
  /** 생산금액 (있으면 요약 시트에 미리 채움) */
  aAmount?: number;
  bAmount?: number;
  /** 앱 화면 계산값 — 엑셀 결과와 대조용 */
  appTotalA: number;
  appTotalB: number;
  /** 고단가로 표시할 원재료명 키워드 (예: ['한우','전복','게살','관자']) */
  highCostTerms: string[];
  /** 고단가에서 뺄 키워드 (예: ['사골육수']) */
  highCostExcludes: string[];
}

interface ProductRow {
  key: string;        // 냉장=코드(canonicalShort), 실온=제품명
  name: string;
  kind: '냉장' | '실온';
  qtyA: number;
  qtyB: number;
  /** 원재료: [원재료키, 원재료명, 개당g] */
  ings: { key: string; name: string; gPerPiece: number }[];
  hasRecipe: boolean;
}

/** 원재료 매칭 키 — 앱(computeMonthlyUsage) 과 동일 규칙 */
function ingKey(name: string, code?: string): string {
  return code ? normalizeCode(code) : normalizeMaterialName(name);
}

function buildProducts(inp: WorkbookInput): ProductRow[] {
  const { aProd, bProd, productNameByCode, recipeMap, ambientRecipeMap } = inp;

  // 냉장 레시피는 canonicalShort 로 재인덱싱 (앱과 동일)
  const normRecipe = new Map<string, Recipe>();
  recipeMap.forEach((r) => {
    const k = canonicalShort(r.code || '');
    if (k && !normRecipe.has(k)) normRecipe.set(k, r);
  });

  const out: ProductRow[] = [];

  // ===== 냉장 =====
  const coldKeys = new Set<string>([...aProd.coldByCode.keys(), ...bProd.coldByCode.keys()]);
  Array.from(coldKeys).sort().forEach((code) => {
    const qtyA = aProd.coldByCode.get(code) || 0;
    const qtyB = bProd.coldByCode.get(code) || 0;
    if (qtyA <= 0 && qtyB <= 0) return;
    const r = normRecipe.get(code);
    out.push({
      key: code,
      name: productNameByCode.get(code) || r?.name || code,
      kind: '냉장',
      qtyA, qtyB,
      hasRecipe: !!r,
      ings: (r?.ingredients || []).map((ing) => ({
        key: ingKey(ing.name, ing.code),
        name: ing.name,
        gPerPiece: ing.gPerPiece || 0,
      })).filter((x) => x.gPerPiece > 0),
    });
  });

  // ===== 실온 =====
  const ambQty = new Map<string, { name: string; a: number; b: number }>();
  aProd.ambient.forEach((x) => {
    const k = normalizeMaterialName(x.productName);
    const cur = ambQty.get(k) || { name: x.productName, a: 0, b: 0 };
    cur.a += x.qty; ambQty.set(k, cur);
  });
  bProd.ambient.forEach((x) => {
    const k = normalizeMaterialName(x.productName);
    const cur = ambQty.get(k) || { name: x.productName, a: 0, b: 0 };
    cur.b += x.qty; ambQty.set(k, cur);
  });
  Array.from(ambQty.entries()).sort((x, y) => x[1].name.localeCompare(y[1].name)).forEach(([k, v]) => {
    if (v.a <= 0 && v.b <= 0) return;
    const r = ambientRecipeMap.get(k);
    const bp = r?.batchPieces || 1;
    out.push({
      key: v.name,
      name: v.name,
      kind: '실온',
      qtyA: v.a, qtyB: v.b,
      hasRecipe: !!r,
      ings: (r?.ingredients || []).map((ing) => ({
        key: ingKey(ing.name, ing.code),
        name: ing.name,
        gPerPiece: (ing.gPerBatch || 0) / bp,   // 개당 환산 (앱과 동일)
      })).filter((x) => x.gPerPiece > 0),
    });
  });

  return out;
}

export async function buildMaterialWorkbook(inp: WorkbookInput): Promise<Blob> {
  const { monthA, monthB, priceMap, priceNameByCode } = inp;
  const products = buildProducts(inp);

  // ===== 원재료 마스터 (레시피에 실제로 쓰인 것만) =====
  const ingMaster = new Map<string, { key: string; name: string; code: string }>();
  products.forEach((p) => p.ings.forEach((ing) => {
    if (ingMaster.has(ing.key)) return;
    // 코드키인지 이름키인지 구분: 코드로 매칭된 건 priceNameByCode 에 정식명이 있다
    const official = priceNameByCode.get(CODE_KEY_PREFIX + ing.key);
    const looksLikeCode = official !== undefined || /^[0-9A-Z\-]{4,}$/.test(ing.key);
    ingMaster.set(ing.key, {
      key: ing.key,
      name: official || ing.name,
      code: looksLikeCode ? ing.key : '',
    });
  }));

  // 단가 조회 — 앱과 동일하게 코드 우선 → 이름
  const priceOf = (month: string, m: { code: string; name: string }): number => {
    if (m.code) {
      const v = priceMap.get(monthPriceKey(month, CODE_KEY_PREFIX + normalizeCode(m.code)));
      if (v !== undefined) return v;
    }
    return priceMap.get(monthPriceKey(month, normalizeMaterialName(m.name))) ?? 0;
  };

  // 고단가 그룹 판정
  const terms = inp.highCostTerms.map(normalizeMaterialName).filter(Boolean);
  const excl = inp.highCostExcludes.map(normalizeMaterialName).filter(Boolean);
  const isHigh = (name: string) => {
    const n = normalizeMaterialName(name);
    if (excl.some((e) => n.includes(e))) return false;
    return terms.some((t) => n.includes(t));
  };

  const wb = new ExcelJS.Workbook();
  wb.creator = '순수본 1공장 MES';
  wb.created = new Date();
  // 파일 열 때 전체 재계산 (수식만 쓰고 캐시값을 안 넣으므로 필수)
  wb.calcProperties.fullCalcOnLoad = true;

  // 요약 시트를 먼저 만들어 첫 탭이 되게 한다 (내용은 뒤에서 채움)
  wb.addWorksheet('요약');

  const HEAD = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10 };
  const headFill = (argb: string) => ({ type: 'pattern' as const, pattern: 'solid' as const, fgColor: { argb } });
  const INPUT_FILL = { type: 'pattern' as const, pattern: 'solid' as const, fgColor: { argb: 'FFFFF2CC' } };
  const thin = { style: 'thin' as const, color: { argb: 'FFD0D0D0' } };
  const BORDER = { top: thin, left: thin, bottom: thin, right: thin };

  const styleHeader = (ws: ExcelJS.Worksheet, row: number, argb: string) => {
    const r = ws.getRow(row);
    r.eachCell((c) => { c.font = HEAD; c.fill = headFill(argb); c.alignment = { horizontal: 'center' }; c.border = BORDER; });
    r.height = 20;
  };

  /* ================= 1. 생산량 ================= */
  const wsQty = wb.addWorksheet('생산량');
  wsQty.columns = [
    { header: '품목키', width: 26 },
    { header: '품목명', width: 34 },
    { header: '구분', width: 8 },
    { header: `${monthA} 생산(EA)`, width: 16 },
    { header: `${monthB} 생산(EA)`, width: 16 },
    { header: '레시피', width: 10 },
  ];
  styleHeader(wsQty, 1, 'FF1F4E79');
  products.forEach((p) => {
    const r = wsQty.addRow([p.key, p.name, p.kind, Math.round(p.qtyA), Math.round(p.qtyB), p.hasRecipe ? 'O' : '없음']);
    r.getCell(4).fill = INPUT_FILL;
    r.getCell(5).fill = INPUT_FILL;
    r.getCell(4).numFmt = '#,##0';
    r.getCell(5).numFmt = '#,##0';
    if (!p.hasRecipe) r.getCell(6).font = { color: { argb: 'FFC00000' }, bold: true };
  });
  wsQty.views = [{ state: 'frozen', ySplit: 1 }];
  if (products.length > 0) wsQty.autoFilter = { from: 'A1', to: `F${products.length + 1}` };

  /* ================= 2. 단가 ================= */
  const wsPrice = wb.addWorksheet('단가');
  wsPrice.columns = [
    { header: '원재료키', width: 20 },
    { header: 'ERP코드', width: 16 },
    { header: '원재료명', width: 32 },
    { header: `${monthA} 단가(원/g)`, width: 17 },
    { header: `${monthB} 단가(원/g)`, width: 17 },
    { header: '그룹', width: 12 },
  ];
  styleHeader(wsPrice, 1, 'FF7030A0');
  const ingList = Array.from(ingMaster.values()).sort((a, b) => a.name.localeCompare(b.name));
  ingList.forEach((m) => {
    const pa = priceOf(monthA, m);
    const pb = priceOf(monthB, m);
    const r = wsPrice.addRow([m.key, m.code, m.name, pa, pb, isHigh(m.name) ? '고단가' : '']);
    r.getCell(4).fill = INPUT_FILL; r.getCell(4).numFmt = '#,##0.000';
    r.getCell(5).fill = INPUT_FILL; r.getCell(5).numFmt = '#,##0.000';
    if (pa === 0 || pb === 0) r.getCell(3).font = { color: { argb: 'FFC00000' } };
  });
  wsPrice.views = [{ state: 'frozen', ySplit: 1 }];
  if (ingList.length > 0) wsPrice.autoFilter = { from: 'A1', to: `F${ingList.length + 1}` };
  const priceLast = ingList.length + 1;

  /* ================= 3. 레시피계산 ================= */
  const wsCalc = wb.addWorksheet('레시피계산');
  wsCalc.columns = [
    { header: '품목키', width: 26 },
    { header: '품목명', width: 30 },
    { header: '구분', width: 7 },
    { header: '원재료키', width: 18 },
    { header: '원재료명', width: 28 },
    { header: '개당 투입(g)', width: 13 },
    { header: `${monthA} 생산EA`, width: 13 },
    { header: `${monthB} 생산EA`, width: 13 },
    { header: `${monthA} 사용량(g)`, width: 15 },
    { header: `${monthB} 사용량(g)`, width: 15 },
    { header: `${monthA} 단가`, width: 11 },
    { header: `${monthB} 단가`, width: 11 },
    { header: `${monthA} 금액`, width: 15 },
    { header: `${monthB} 금액`, width: 15 },
  ];
  styleHeader(wsCalc, 1, 'FF2E75B6');
  const qtyLast = products.length + 1;
  let cRow = 1;
  products.forEach((p) => {
    p.ings.forEach((ing) => {
      cRow += 1;
      const R = cRow;
      const row = wsCalc.addRow([
        p.key, p.name, p.kind, ing.key, ing.name, ing.gPerPiece,
        { formula: `IFERROR(VLOOKUP($A${R},생산량!$A$2:$E$${qtyLast},4,FALSE),0)` },
        { formula: `IFERROR(VLOOKUP($A${R},생산량!$A$2:$E$${qtyLast},5,FALSE),0)` },
        { formula: `$F${R}*$G${R}` },
        { formula: `$F${R}*$H${R}` },
        { formula: `IFERROR(VLOOKUP($D${R},단가!$A$2:$E$${priceLast},4,FALSE),0)` },
        { formula: `IFERROR(VLOOKUP($D${R},단가!$A$2:$E$${priceLast},5,FALSE),0)` },
        { formula: `$I${R}*$K${R}` },
        { formula: `$J${R}*$L${R}` },
      ]);
      row.getCell(6).numFmt = '#,##0.0000';
      [7, 8].forEach((c) => { row.getCell(c).numFmt = '#,##0'; });
      [9, 10].forEach((c) => { row.getCell(c).numFmt = '#,##0'; });
      [11, 12].forEach((c) => { row.getCell(c).numFmt = '#,##0.000'; });
      [13, 14].forEach((c) => { row.getCell(c).numFmt = '#,##0'; });
    });
  });
  const calcLast = cRow;
  wsCalc.views = [{ state: 'frozen', ySplit: 1 }];
  if (calcLast > 1) wsCalc.autoFilter = { from: 'A1', to: `N${calcLast}` };

  /* ================= 4. 원재료집계 ================= */
  const wsAgg = wb.addWorksheet('원재료집계');
  wsAgg.columns = [
    { header: '원재료키', width: 18 },
    { header: '원재료명', width: 32 },
    { header: '그룹', width: 10 },
    { header: `${monthA} 사용량(g)`, width: 16 },
    { header: `${monthB} 사용량(g)`, width: 16 },
    { header: `${monthA} 금액`, width: 16 },
    { header: `${monthB} 금액`, width: 16 },
    { header: '금액 증감', width: 16 },
    { header: '증감률', width: 10 },
  ];
  styleHeader(wsAgg, 1, 'FF548235');
  ingList.forEach((m, i) => {
    const R = i + 2;
    const row = wsAgg.addRow([
      m.key, m.name,
      { formula: `IFERROR(VLOOKUP($A${R},단가!$A$2:$F$${priceLast},6,FALSE),"")` },
      { formula: `SUMIF(레시피계산!$D$2:$D$${calcLast},$A${R},레시피계산!$I$2:$I$${calcLast})` },
      { formula: `SUMIF(레시피계산!$D$2:$D$${calcLast},$A${R},레시피계산!$J$2:$J$${calcLast})` },
      { formula: `SUMIF(레시피계산!$D$2:$D$${calcLast},$A${R},레시피계산!$M$2:$M$${calcLast})` },
      { formula: `SUMIF(레시피계산!$D$2:$D$${calcLast},$A${R},레시피계산!$N$2:$N$${calcLast})` },
      { formula: `$G${R}-$F${R}` },
      { formula: `IF($F${R}=0,"",$G${R}/$F${R}-1)` },
    ]);
    [4, 5].forEach((c) => { row.getCell(c).numFmt = '#,##0'; });
    [6, 7, 8].forEach((c) => { row.getCell(c).numFmt = '#,##0'; });
    row.getCell(9).numFmt = '0.0%';
  });
  const aggLast = ingList.length + 1;
  wsAgg.views = [{ state: 'frozen', ySplit: 1 }];
  if (ingList.length > 0) wsAgg.autoFilter = { from: 'A1', to: `I${aggLast}` };

  /* ================= 5. 요약 ================= */
  const ws = wb.getWorksheet('요약')!;
  ws.columns = [{ width: 30 }, { width: 20 }, { width: 20 }, { width: 18 }, { width: 46 }];

  const title = ws.addRow(['원재료비 분석 (수식 연동)']);
  title.getCell(1).font = { bold: true, size: 15, color: { argb: 'FF1F4E79' } };
  ws.addRow([`비교월: ${monthA} vs ${monthB}   ·   노란칸만 입력하면 아래가 전부 자동 계산됩니다`])
    .getCell(1).font = { size: 10, color: { argb: 'FF808080' } };
  ws.addRow([]);

  const hdr = ws.addRow(['항목', monthA, monthB, '증감', '설명']);
  styleHeader(ws, hdr.number, 'FF1F4E79');

  /** 한 줄 추가. delta 는 이 행 번호(R)를 받아 수식 문자열을 돌려준다 */
  const put = (
    label: string,
    a: (R: number) => ExcelJS.CellValue,
    b: (R: number) => ExcelJS.CellValue,
    delta: ((R: number) => string) | null,
    note: string,
    fmt = '#,##0',
    input = false,
  ): number => {
    const R = ws.rowCount + 1;
    const r = ws.addRow([label, a(R), b(R), delta ? { formula: delta(R) } : null, note]);
    r.getCell(1).font = { bold: true };
    [2, 3, 4].forEach((c) => { r.getCell(c).numFmt = fmt; r.getCell(c).border = BORDER; });
    if (input) { r.getCell(2).fill = INPUT_FILL; r.getCell(3).fill = INPUT_FILL; }
    r.getCell(5).font = { size: 9, color: { argb: 'FF808080' } };
    return R;
  };
  const diffBC = (R: number) => `IF(OR(B${R}="",C${R}=""),"",C${R}-B${R})`;

  const rAmt = put('① 생산금액 (원)  ← 입력',
    () => (inp.aAmount && inp.aAmount > 0 ? inp.aAmount : null),
    () => (inp.bAmount && inp.bAmount > 0 ? inp.bAmount : null),
    diffBC, 'ERP 월 생산금액을 직접 입력하세요', '#,##0', true);

  const rQty = put('② 총 생산량 (EA)',
    () => ({ formula: `SUM(생산량!D2:D${qtyLast})` }),
    () => ({ formula: `SUM(생산량!E2:E${qtyLast})` }),
    diffBC, '생산량 시트 합계 (수정하면 여기도 바뀝니다)');

  const rMat = put('③ 총 원재료비 (원)',
    () => ({ formula: `SUM(원재료집계!F2:F${aggLast})` }),
    () => ({ formula: `SUM(원재료집계!G2:G${aggLast})` }),
    diffBC, '레시피 × 생산량 × 단가');

  put('④ 개당 재료비 (원/EA)',
    () => ({ formula: `IF(B${rQty}=0,"",B${rMat}/B${rQty})` }),
    () => ({ formula: `IF(C${rQty}=0,"",C${rMat}/C${rQty})` }),
    diffBC, '③ ÷ ②', '#,##0.0');

  const rRate = put('⑤ 원재료비율',
    () => ({ formula: `IF(OR(B${rAmt}="",B${rAmt}=0),"",B${rMat}/B${rAmt})` }),
    () => ({ formula: `IF(OR(C${rAmt}="",C${rAmt}=0),"",C${rMat}/C${rAmt})` }),
    diffBC, '③ ÷ ①   ← ①을 넣어야 나옵니다', '0.00%');
  ws.getRow(rRate).getCell(2).font = { bold: true, size: 12, color: { argb: 'FFC00000' } };
  ws.getRow(rRate).getCell(3).font = { bold: true, size: 12, color: { argb: 'FFC00000' } };

  put('⑥ 개당 생산금액 (원/EA)',
    () => ({ formula: `IF(OR(B${rAmt}="",B${rQty}=0),"",B${rAmt}/B${rQty})` }),
    () => ({ formula: `IF(OR(C${rAmt}="",C${rQty}=0),"",C${rAmt}/C${rQty})` }),
    diffBC, '① ÷ ②  — 제품 믹스 효과가 여기서 보입니다');

  ws.addRow([]);
  const h2 = ws.addRow(['고단가 원재료', monthA, monthB, '증감', '설명']);
  styleHeader(ws, h2.number, 'FF7030A0');

  const HG = (col: 'D' | 'E' | 'F' | 'G') => `SUMIF(원재료집계!$C$2:$C$${aggLast},"고단가",원재료집계!$${col}$2:$${col}$${aggLast})`;
  const rHigh = put('⑦ 고단가 재료비 (원)',
    () => ({ formula: HG('F') }), () => ({ formula: HG('G') }), diffBC,
    `단가 시트 '그룹'열이 고단가인 것만 (${inp.highCostTerms.join('·')})`);
  const rHighG = put('⑧ 고단가 사용량 (g)',
    () => ({ formula: HG('D') }), () => ({ formula: HG('E') }), diffBC, '');
  put('⑨ 고단가 비중 (재료비)',
    () => ({ formula: `IF(B${rMat}=0,"",B${rHigh}/B${rMat})` }),
    () => ({ formula: `IF(C${rMat}=0,"",C${rHigh}/C${rMat})` }),
    diffBC, '⑦ ÷ ③', '0.00%');
  put('⑩ 고단가 평균단가 (원/g)',
    () => ({ formula: `IF(B${rHighG}=0,"",B${rHigh}/B${rHighG})` }),
    () => ({ formula: `IF(C${rHighG}=0,"",C${rHigh}/C${rHighG})` }),
    diffBC, '올라가면 = 고단가 안에서 더 비싼 원재료 쪽으로 이동', '#,##0.00');

  ws.addRow([]);
  const h3 = ws.addRow(['검증', monthA, monthB, '차이', '설명']);
  styleHeader(ws, h3.number, 'FF808080');
  const rApp = put('앱(MES) 계산값',
    () => inp.appTotalA, () => inp.appTotalB, null, '엑셀 ③ 과 같아야 정상');
  put('차이 (엑셀 ③ - 앱)',
    () => ({ formula: `B${rMat}-B${rApp}` }),
    () => ({ formula: `C${rMat}-C${rApp}` }), null, '0 이면 두 계산이 완전히 일치');

  ws.addRow([]);
  const guide = [
    '■ 쓰는 법',
    '  1) [요약] ① 생산금액에 두 달치 ERP 생산금액을 넣으면 ⑤ 원재료비율이 바로 나옵니다.',
    '  2) [생산량] 시트의 노란칸(생산개수)을 고치면 사용량·금액·비율이 전부 자동으로 다시 계산됩니다.',
    '  3) [단가] 시트의 노란칸(원/g)을 고치면 단가 시나리오를 바로 볼 수 있습니다.',
    "     · 양쪽 열에 같은 달 단가를 넣으면 '단가효과 제거(연동예산)' 이 됩니다.",
    "  4) [단가] 시트 '그룹'열이 고단가 인 원재료만 ⑦~⑩ 에 집계됩니다. 직접 넣고 뺄 수 있습니다.",
    '',
    '■ 계산식 (전부 엑셀 수식으로 들어 있습니다)',
    '  사용량(g) = 개당 투입량(g) × 생산개수(EA)        … 레시피계산 I·J열',
    '  금액(원)  = 사용량(g) × 단가(원/g)               … 레시피계산 M·N열',
    '  총 원재료비 = 위 금액의 전체 합                   … 원재료집계 → 요약 ③',
    '  원재료비율  = 총 원재료비 ÷ 생산금액              … 요약 ⑤',
    '',
    '■ 주의',
    '  · 이 표는 레시피 기준 이론 재료비입니다. ERP 실제 출고와의 차이는 수율·재고 영향입니다.',
    '  · [생산량] 시트 F열이 "없음" 인 품목은 레시피가 없어 재료비 0으로 빠집니다.',
  ];
  guide.forEach((g) => {
    const r = ws.addRow([g]);
    r.getCell(1).font = g.startsWith('■')
      ? { bold: true, size: 10, color: { argb: 'FF1F4E79' } }
      : { size: 9, color: { argb: 'FF404040' } };
  });

  const buf = await wb.xlsx.writeBuffer();
  return new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}
