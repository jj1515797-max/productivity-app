/** 원재료비 분석 — 수식이 살아있는 엑셀 워크북 생성
 *
 *  앱이 계산한 "결과값"이 아니라 계산에 쓰인 DB(레시피·단가·생산량)를 그대로 넣고
 *  엑셀 수식으로 다시 계산되게 만든다. 생산개수·단가·공급가를 바꾸면 즉시 재계산된다.
 *
 *  시트
 *   요약        : 입력(노란칸) + 원재료비율/개당재료비/고단가/믹스분해
 *   생산량      : 품목별 생산개수
 *   제품수익성  : 제품별 재료비·공급가·원가율 (공급가 입력하면 활성화)
 *   레시피계산  : 레시피 1줄 = 품목×원재료. 사용량/금액을 수식으로 산출
 *   단가        : 원재료별 월 단가(원/g) + 그룹(고단가 등)
 *   원재료집계  : 원재료별 SUMIF 집계
 */
import ExcelJS from 'exceljs';
import type { AmbientRecipe, Recipe } from './wasteCompute';
import { CODE_KEY_PREFIX, monthPriceKey, normalizeCode, normalizeMaterialName } from './wasteCompute';
import { canonicalShort } from './codeUtil';
import { findAmbientErp, looseKey } from './ambientProducts';
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
  /** 고단가로 표시할 원재료명 키워드 */
  highCostTerms: string[];
  /** 고단가에서 뺄 키워드 */
  highCostExcludes: string[];
  /** 제품 공급가 (원/EA). 키 = 냉장 canonicalShort 코드 / 실온 normalizeName(제품명) */
  supplyPrices?: Record<string, number>;
  /** 제품 DB(productSettings) 의 전체 ERP 코드 목록 — 품목키를 A-001-01 형태로 표시하는 데 사용 */
  productCodes?: { code: string; name?: string }[];
}

interface ProductRow {
  /** 시트에서 쓰는 표시·매칭 키. 냉장=제품DB 전체코드(A-001-01), 실온=제품명 */
  key: string;
  /** 냉장 단축코드(A01) / 실온 앱 내부 제품명(순수본_한우야채진밥) — 앱 내부 매칭용 */
  shortCode: string;
  /** 같은 단축코드를 쓰는 다른 전체코드들 (있으면 표시) */
  altCodes: string;
  name: string;
  kind: '냉장' | '실온';
  qtyA: number;
  qtyB: number;
  ings: { key: string; name: string; gPerPiece: number }[];
  hasRecipe: boolean;
}

/** 원재료 매칭 키 — 앱(computeMonthlyUsage) 과 동일 규칙 */
function ingKey(name: string, code?: string): string {
  return code ? normalizeCode(code) : normalizeMaterialName(name);
}

/** 전체 ERP 코드처럼 생겼는지 (A-001-01) */
function isFullErpCode(c: string): boolean {
  return /^[A-Za-z]-\d+-\d+$/.test((c || '').trim());
}

function buildProducts(inp: WorkbookInput): ProductRow[] {
  const { aProd, bProd, productNameByCode, recipeMap, ambientRecipeMap } = inp;

  const normRecipe = new Map<string, Recipe>();
  recipeMap.forEach((r) => {
    const k = canonicalShort(r.code || '');
    if (k && !normRecipe.has(k)) normRecipe.set(k, r);
  });

  // 단축코드(A01) → 제품DB 전체코드 후보들 (A-001-01, A-001-51 …)
  const fullByShort = new Map<string, { code: string; name?: string }[]>();
  (inp.productCodes || []).forEach((p) => {
    if (!isFullErpCode(p.code)) return;
    const k = canonicalShort(p.code);
    if (!k) return;
    const arr = fullByShort.get(k) || [];
    arr.push(p);
    fullByShort.set(k, arr);
  });
  fullByShort.forEach((arr) => arr.sort((a, b) => a.code.localeCompare(b.code)));

  /** 단축코드에 대응하는 표시용 전체코드 고르기
   *  1) 레시피 문서 ID 가 전체코드면 그것 (실제 계산에 쓰인 코드)
   *  2) 제품DB 후보 중 생산 제품명과 일치하는 것
   *  3) 제품DB 후보 첫 번째
   *  4) 없으면 단축코드 그대로 */
  const pickFull = (short: string, prodName: string, recipeCode?: string): { code: string; alts: string } => {
    const cands = fullByShort.get(short) || [];
    const altList = cands.map((c) => c.code);
    const alts = altList.length > 1 ? altList.join(' / ') : '';
    if (recipeCode && isFullErpCode(recipeCode)) return { code: recipeCode.trim().toUpperCase(), alts };
    if (cands.length > 0) {
      const nm = normalizeMaterialName(prodName);
      const hit = cands.find((c) => c.name && normalizeMaterialName(c.name) === nm);
      return { code: (hit || cands[0]).code.trim().toUpperCase(), alts };
    }
    return { code: short, alts };
  };

  const out: ProductRow[] = [];

  // ===== 냉장 =====
  const coldKeys = new Set<string>([...aProd.coldByCode.keys(), ...bProd.coldByCode.keys()]);
  Array.from(coldKeys).sort().forEach((code) => {
    const qtyA = aProd.coldByCode.get(code) || 0;
    const qtyB = bProd.coldByCode.get(code) || 0;
    if (qtyA <= 0 && qtyB <= 0) return;
    const r = normRecipe.get(code);
    const nm = productNameByCode.get(code) || r?.name || code;
    const { code: fullCode, alts } = pickFull(code, nm, r?.code);
    out.push({
      key: fullCode,
      shortCode: code,
      altCodes: alts,
      name: nm,
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
    // 실온도 ERP 품목코드/등록명으로 표기 (없으면 내부 제품명 그대로)
    const erp = findAmbientErp(v.name);
    out.push({
      key: erp ? erp.code : v.name,
      shortCode: v.name,
      altCodes: '',
      name: erp ? erp.name : v.name,
      kind: '실온',
      qtyA: v.a, qtyB: v.b,
      hasRecipe: !!r,
      ings: (r?.ingredients || []).map((ing) => ({
        key: ingKey(ing.name, ing.code),
        name: ing.name,
        gPerPiece: (ing.gPerBatch || 0) / bp,
      })).filter((x) => x.gPerPiece > 0),
    });
  });

  return out;
}

export async function buildMaterialWorkbook(inp: WorkbookInput): Promise<Blob> {
  const { monthA, monthB, priceMap, priceNameByCode } = inp;
  const products = buildProducts(inp);

  // ===== 원재료 마스터 =====
  const ingMaster = new Map<string, { key: string; name: string; code: string }>();
  products.forEach((p) => p.ings.forEach((ing) => {
    if (ingMaster.has(ing.key)) return;
    const official = priceNameByCode.get(CODE_KEY_PREFIX + ing.key);
    const looksLikeCode = official !== undefined || /^[0-9A-Z\-]{4,}$/.test(ing.key);
    ingMaster.set(ing.key, { key: ing.key, name: official || ing.name, code: looksLikeCode ? ing.key : '' });
  }));

  const priceOf = (month: string, m: { code: string; name: string }): number => {
    if (m.code) {
      const v = priceMap.get(monthPriceKey(month, CODE_KEY_PREFIX + normalizeCode(m.code)));
      if (v !== undefined) return v;
    }
    return priceMap.get(monthPriceKey(month, normalizeMaterialName(m.name))) ?? 0;
  };

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
  wb.calcProperties.fullCalcOnLoad = true;

  wb.addWorksheet('요약');   // 첫 탭 선점

  const HEAD = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10 };
  const headFill = (argb: string) => ({ type: 'pattern' as const, pattern: 'solid' as const, fgColor: { argb } });
  const INPUT_FILL = { type: 'pattern' as const, pattern: 'solid' as const, fgColor: { argb: 'FFFFF2CC' } };
  const thin = { style: 'thin' as const, color: { argb: 'FFD0D0D0' } };
  const BORDER = { top: thin, left: thin, bottom: thin, right: thin };
  const NOTE = { size: 9, color: { argb: 'FF808080' } };

  const styleHeader = (ws: ExcelJS.Worksheet, row: number, argb: string) => {
    const r = ws.getRow(row);
    r.eachCell((c) => { c.font = HEAD; c.fill = headFill(argb); c.alignment = { horizontal: 'center', wrapText: true }; c.border = BORDER; });
    r.height = 22;
  };

  const qtyLast = products.length + 1;
  const ingList = Array.from(ingMaster.values()).sort((a, b) => a.name.localeCompare(b.name));
  const priceLast = ingList.length + 1;
  const aggLast = ingList.length + 1;
  // 레시피계산 행수 미리 계산 (다른 시트 수식이 참조)
  const calcLast = 1 + products.reduce((s, p) => s + p.ings.length, 0);
  const profitLast = products.length + 1;

  /* ================= 생산량 ================= */
  const wsQty = wb.addWorksheet('생산량');
  wsQty.columns = [
    { header: '품목코드', width: 18 },
    { header: '품목명', width: 34 },
    { header: '구분', width: 8 },
    { header: `${monthA} 생산(EA)`, width: 16 },
    { header: `${monthB} 생산(EA)`, width: 16 },
    { header: '레시피', width: 10 },
    { header: '고단가 포함', width: 12 },
    { header: '앱 내부키', width: 24 },
    { header: '같은 단축코드 (합산됨)', width: 26 },
  ];
  styleHeader(wsQty, 1, 'FF1F4E79');
  products.forEach((p, i) => {
    const R = i + 2;
    // 생산량은 반올림하지 않고 원값 그대로 (잔여량 비례배분으로 소수점이 생김).
    // 표시만 정수로 보이게 서식 처리 → 합계가 앱과 정확히 일치한다.
    const r = wsQty.addRow([
      p.key, p.name, p.kind, p.qtyA, p.qtyB, p.hasRecipe ? 'O' : '없음',
      { formula: `IF(COUNTIFS(레시피계산!$A$2:$A$${calcLast},$A${R},레시피계산!$O$2:$O$${calcLast},"고단가")>0,"O","")` },
      p.shortCode, p.altCodes,
    ]);
    r.getCell(4).fill = INPUT_FILL; r.getCell(4).numFmt = '#,##0';
    r.getCell(5).fill = INPUT_FILL; r.getCell(5).numFmt = '#,##0';
    r.getCell(7).alignment = { horizontal: 'center' };
    if (!p.hasRecipe) r.getCell(6).font = { color: { argb: 'FFC00000' }, bold: true };
  });
  wsQty.views = [{ state: 'frozen', ySplit: 1 }];
  products.forEach((p, i) => {
    if (p.altCodes) {
      const c = wsQty.getRow(i + 2).getCell(9);
      c.font = { size: 9, color: { argb: 'FFB45309' } };
    }
  });
  if (products.length > 0) wsQty.autoFilter = { from: 'A1', to: `I${qtyLast}` };

  /* ================= 단가 ================= */
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
  ingList.forEach((m) => {
    const pa = priceOf(monthA, m);
    const pb = priceOf(monthB, m);
    const r = wsPrice.addRow([m.key, m.code, m.name, pa, pb, isHigh(m.name) ? '고단가' : '']);
    r.getCell(4).fill = INPUT_FILL; r.getCell(4).numFmt = '#,##0.000';
    r.getCell(5).fill = INPUT_FILL; r.getCell(5).numFmt = '#,##0.000';
    r.getCell(6).alignment = { horizontal: 'center' };
    if (pa === 0 || pb === 0) r.getCell(3).font = { color: { argb: 'FFC00000' } };
  });
  wsPrice.views = [{ state: 'frozen', ySplit: 1 }];
  if (ingList.length > 0) wsPrice.autoFilter = { from: 'A1', to: `F${priceLast}` };

  /* ================= 레시피계산 ================= */
  const wsCalc = wb.addWorksheet('레시피계산');
  wsCalc.columns = [
    { header: '품목코드', width: 18 },
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
    { header: '그룹', width: 10 },
  ];
  styleHeader(wsCalc, 1, 'FF2E75B6');
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
        { formula: `IFERROR(VLOOKUP($D${R},단가!$A$2:$F$${priceLast},6,FALSE),"")` },
      ]);
      row.getCell(6).numFmt = '#,##0.0000';
      [7, 8, 9, 10, 13, 14].forEach((c) => { row.getCell(c).numFmt = '#,##0'; });
      [11, 12].forEach((c) => { row.getCell(c).numFmt = '#,##0.000'; });
    });
  });
  wsCalc.views = [{ state: 'frozen', ySplit: 1 }];
  if (calcLast > 1) wsCalc.autoFilter = { from: 'A1', to: `O${calcLast}` };

  /* ================= 제품수익성 ================= */
  const wsPro = wb.addWorksheet('제품수익성');
  wsPro.columns = [
    { header: '품목코드', width: 18 },
    { header: '품목명', width: 34 },
    { header: '구분', width: 7 },
    { header: '공급가(원/EA) ← 입력', width: 18 },
    { header: `${monthA} 생산EA`, width: 13 },
    { header: `${monthB} 생산EA`, width: 13 },
    { header: `${monthA} 재료비`, width: 15 },
    { header: `${monthB} 재료비`, width: 15 },
    { header: `${monthA} 재료비/EA`, width: 14 },
    { header: `${monthB} 재료비/EA`, width: 14 },
    { header: `${monthA} 공급가액`, width: 16 },
    { header: `${monthB} 공급가액`, width: 16 },
    { header: `${monthA} 원가율`, width: 12 },
    { header: `${monthB} 원가율`, width: 12 },
    { header: `${monthB} 매출비중`, width: 12 },
    { header: '믹스기준(A원가율×B비중)', width: 20 },
    { header: `${monthB} 한계이익`, width: 16 },
    { header: '앱 내부키', width: 24 },
  ];
  styleHeader(wsPro, 1, 'FFC55A11');
  const supplyOf = (p: ProductRow): number | null => {
    const m = inp.supplyPrices || {};
    const cands = p.kind === '냉장'
      ? [canonicalShort(p.key), p.key, looseKey(p.key), looseKey(p.name)]
      : [looseKey(p.key), looseKey(p.name), looseKey(p.shortCode), normalizeMaterialName(p.name), p.key];
    for (const c of cands) {
      const v = c ? m[c] : undefined;
      if (v && v > 0) return v;
    }
    return null;
  };
  products.forEach((p, i) => {
    const R = i + 2;
    const row = wsPro.addRow([
      p.key, p.name, p.kind,
      supplyOf(p),
      { formula: `IFERROR(VLOOKUP($A${R},생산량!$A$2:$E$${qtyLast},4,FALSE),0)` },
      { formula: `IFERROR(VLOOKUP($A${R},생산량!$A$2:$E$${qtyLast},5,FALSE),0)` },
      { formula: `SUMIF(레시피계산!$A$2:$A$${calcLast},$A${R},레시피계산!$M$2:$M$${calcLast})` },
      { formula: `SUMIF(레시피계산!$A$2:$A$${calcLast},$A${R},레시피계산!$N$2:$N$${calcLast})` },
      { formula: `IF($E${R}=0,"",$G${R}/$E${R})` },
      { formula: `IF($F${R}=0,"",$H${R}/$F${R})` },
      { formula: `$D${R}*$E${R}` },
      { formula: `$D${R}*$F${R}` },
      { formula: `IF($K${R}=0,"",$G${R}/$K${R})` },
      { formula: `IF($L${R}=0,"",$H${R}/$L${R})` },
      { formula: `IF(SUM($L$2:$L$${profitLast})=0,"",$L${R}/SUM($L$2:$L$${profitLast}))` },
      { formula: `IF(OR($M${R}="",$O${R}=""),0,$M${R}*$O${R})` },
      { formula: `IF($L${R}=0,"",$L${R}-$H${R})` },
      p.shortCode,
    ]);
    row.getCell(4).fill = INPUT_FILL; row.getCell(4).numFmt = '#,##0';
    [5, 6, 7, 8, 11, 12, 17].forEach((c) => { row.getCell(c).numFmt = '#,##0'; });
    [9, 10].forEach((c) => { row.getCell(c).numFmt = '#,##0.0'; });
    [13, 14, 15, 16].forEach((c) => { row.getCell(c).numFmt = '0.00%'; });
  });
  wsPro.views = [{ state: 'frozen', ySplit: 1 }];
  if (products.length > 0) wsPro.autoFilter = { from: 'A1', to: `R${profitLast}` };

  /* ================= 원재료집계 ================= */
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
    [4, 5, 6, 7, 8].forEach((c) => { row.getCell(c).numFmt = '#,##0'; });
    row.getCell(9).numFmt = '0.0%';
  });
  wsAgg.views = [{ state: 'frozen', ySplit: 1 }];
  if (ingList.length > 0) wsAgg.autoFilter = { from: 'A1', to: `I${aggLast}` };

  /* ================= 요약 ================= */
  const ws = wb.getWorksheet('요약')!;
  ws.columns = [{ width: 32 }, { width: 20 }, { width: 20 }, { width: 18 }, { width: 50 }];

  ws.addRow(['원재료비 분석 (수식 연동)']).getCell(1).font = { bold: true, size: 16, color: { argb: 'FF1F4E79' } };
  ws.addRow([`비교월: ${monthA} vs ${monthB}   ·   노란칸만 입력하면 아래가 전부 자동 계산됩니다`]).getCell(1).font = NOTE;
  ws.addRow([]);

  const section = (title: string, argb: string) => {
    const r = ws.addRow([title, monthA, monthB, '증감', '설명']);
    styleHeader(ws, r.number, argb);
  };

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
    r.getCell(5).font = NOTE;
    return R;
  };
  const dBC = (R: number) => `IF(OR(B${R}="",C${R}=""),"",C${R}-B${R})`;

  section('기본', 'FF1F4E79');
  const rAmt = put('① 생산금액 (원)  ← 입력',
    () => (inp.aAmount && inp.aAmount > 0 ? inp.aAmount : null),
    () => (inp.bAmount && inp.bAmount > 0 ? inp.bAmount : null),
    dBC, 'ERP 월 생산금액. 제품수익성에 공급가를 넣으면 ⑬으로 자동 검증됩니다', '#,##0', true);
  const rQty = put('② 총 생산량 (EA)',
    () => ({ formula: `SUM(생산량!D2:D${qtyLast})` }),
    () => ({ formula: `SUM(생산량!E2:E${qtyLast})` }),
    dBC, '생산량 시트 합계');
  const rMat = put('③ 총 원재료비 (원)',
    () => ({ formula: `SUM(원재료집계!F2:F${aggLast})` }),
    () => ({ formula: `SUM(원재료집계!G2:G${aggLast})` }),
    dBC, '레시피 × 생산량 × 단가 (이론값)');
  const rUnit = put('④ 개당 재료비 (원/EA)',
    () => ({ formula: `IF(B${rQty}=0,"",B${rMat}/B${rQty})` }),
    () => ({ formula: `IF(C${rQty}=0,"",C${rMat}/C${rQty})` }),
    dBC, '③ ÷ ②', '#,##0.0');
  const rRate = put('⑤ 원재료비율 (이론)',
    () => ({ formula: `IF(N(B${rAmt})=0,"",B${rMat}/B${rAmt})` }),
    () => ({ formula: `IF(N(C${rAmt})=0,"",C${rMat}/C${rAmt})` }),
    dBC, '③ ÷ ①', '0.00%');
  [2, 3].forEach((c) => { ws.getRow(rRate).getCell(c).font = { bold: true, size: 12, color: { argb: 'FFC00000' } }; });
  put('⑥ 개당 생산금액 (원/EA)',
    () => ({ formula: `IF(OR(N(B${rAmt})=0,B${rQty}=0),"",B${rAmt}/B${rQty})` }),
    () => ({ formula: `IF(OR(N(C${rAmt})=0,C${rQty}=0),"",C${rAmt}/C${rQty})` }),
    dBC, '① ÷ ②  — 제품 믹스가 판가에 준 영향');

  ws.addRow([]);
  section('이론 vs 실제 (ERP 실제 원재료비 입력)', 'FFC00000');
  const rAct = put('⑦ ERP 실제 원재료비 (원)  ← 입력',
    () => null, () => null, dBC,
    'ERP 실제 출고(투입) 금액. 넣으면 수율/재고 효과가 분리됩니다', '#,##0', true);
  const rYield = put('⑧ 실제 ÷ 이론',
    () => ({ formula: `IF(N(B${rAct})=0,"",B${rAct}/B${rMat})` }),
    () => ({ formula: `IF(N(C${rAct})=0,"",C${rAct}/C${rMat})` }),
    dBC, '100% 미만 = 레시피보다 덜 투입 (수율↑ 또는 재고 영향)', '0.0%');
  put('⑨ 실제 기준 원재료비율',
    () => ({ formula: `IF(OR(N(B${rAct})=0,N(B${rAmt})=0),"",B${rAct}/B${rAmt})` }),
    () => ({ formula: `IF(OR(N(C${rAct})=0,N(C${rAmt})=0),"",C${rAct}/C${rAmt})` }),
    dBC, '⑦ ÷ ①  — ERP 보고 수치와 같아야 합니다', '0.00%');

  ws.addRow([]);
  section(`고단가 원재료 (${inp.highCostTerms.join('·')})`, 'FF7030A0');
  const HG = (col: 'D' | 'E' | 'F' | 'G') => `SUMIF(원재료집계!$C$2:$C$${aggLast},"고단가",원재료집계!$${col}$2:$${col}$${aggLast})`;
  const rHigh = put('⑩ 고단가 재료비 (원)',
    () => ({ formula: HG('F') }), () => ({ formula: HG('G') }), dBC,
    "단가 시트 '그룹'열이 고단가인 원재료만");
  const rHighG = put('⑪ 고단가 사용량 (g)',
    () => ({ formula: HG('D') }), () => ({ formula: HG('E') }), dBC, '');
  put('⑫ 고단가 비중 (재료비 기준)',
    () => ({ formula: `IF(B${rMat}=0,"",B${rHigh}/B${rMat})` }),
    () => ({ formula: `IF(C${rMat}=0,"",C${rHigh}/C${rMat})` }),
    dBC, '⑩ ÷ ③', '0.00%');
  const rHighQty = put('⑬ 고단가 포함 품목 생산량 (EA)',
    () => ({ formula: `SUMIF(생산량!$G$2:$G$${qtyLast},"O",생산량!$D$2:$D$${qtyLast})` }),
    () => ({ formula: `SUMIF(생산량!$G$2:$G$${qtyLast},"O",생산량!$E$2:$E$${qtyLast})` }),
    dBC, '고단가 원재료가 하나라도 들어간 제품의 생산량');
  put('⑭ 고단가 비중 (생산량 기준)',
    () => ({ formula: `IF(B${rQty}=0,"",B${rHighQty}/B${rQty})` }),
    () => ({ formula: `IF(C${rQty}=0,"",C${rHighQty}/C${rQty})` }),
    dBC, '⑬ ÷ ②  — 앱 화면의 "투입 품목 생산 비중"과 같은 값', '0.00%');
  const rAvg = put('⑮ 고단가 평균단가 (원/g)',
    () => ({ formula: `IF(B${rHighG}=0,"",B${rHigh}/B${rHighG})` }),
    () => ({ formula: `IF(C${rHighG}=0,"",C${rHigh}/C${rHighG})` }),
    dBC, '올라가면 = 고단가 안에서 더 비싼 원재료 쪽으로 이동', '#,##0.00');

  ws.addRow([]);
  section('제품 공급가 기준 (제품수익성 시트에 공급가 입력 시)', 'FFC55A11');
  const supSum = (col: 'K' | 'L') => `SUM(제품수익성!$${col}$2:$${col}$${profitLast})`;
  const rSup = put('⑯ 공급가액 합계 (자동)',
    () => ({ formula: `${supSum('K')}` }), () => ({ formula: `${supSum('L')}` }), dBC,
    '제품별 공급가 × 생산량 — ①과 비슷해야 정상');
  put('⑰ ① 대비 차이',
    () => ({ formula: `IF(OR(N(B${rAmt})=0,B${rSup}=0),"",B${rSup}-B${rAmt})` }),
    () => ({ formula: `IF(OR(N(C${rAmt})=0,C${rSup}=0),"",C${rSup}-C${rAmt})` }),
    null, '공급가 입력이 맞는지 확인용');
  const rRateS = put('⑱ 원가율 (공급가 기준)',
    () => ({ formula: `IF(B${rSup}=0,"",B${rMat}/B${rSup})` }),
    () => ({ formula: `IF(C${rSup}=0,"",C${rMat}/C${rSup})` }),
    dBC, '③ ÷ ⑯', '0.00%');
  const rMix = put('⑲ 믹스 기준 원가율',
    () => ({ formula: `IF(B${rSup}=0,"",SUM(제품수익성!$P$2:$P$${profitLast}))` }),
    () => null,
    null, `${monthA} 제품별 원가율을 ${monthB} 제품구성에 적용한 값`, '0.00%');
  const rMixEff = put('⑳ 제품구성(믹스) 효과',
    () => ({ formula: `IF(OR(B${rRateS}="",B${rMix}=""),"",B${rMix}-B${rRateS})` }),
    () => null, null,
    '어떤 제품을 많이 만들었나 → 원가율에 준 영향', '0.00%');
  put('㉑ 제품별 원가율 효과',
    () => ({ formula: `IF(OR(C${rRateS}="",B${rMix}=""),"",C${rRateS}-B${rMix})` }),
    () => null, null,
    '제품 하나하나의 원가율이 변한 효과 (레시피·단가·수율)', '0.00%');
  put('㉒ 합계 (=⑱ 증감)',
    () => ({ formula: `IF(OR(B${rRateS}="",C${rRateS}=""),"",C${rRateS}-B${rRateS})` }),
    () => null, null, '⑳ + ㉑ 과 같아야 정상', '0.00%');
  put(`㉓ ${monthB} 한계이익 (공급가-재료비)`,
    () => ({ formula: `IF(B${rSup}=0,"",SUM(제품수익성!$Q$2:$Q$${profitLast}))` }),
    () => null, null, '재료비만 뺀 값 (노무비·경비 제외)');

  ws.addRow([]);
  section('검증', 'FF808080');
  const rApp = put('앱(MES) 계산값', () => inp.appTotalA, () => inp.appTotalB, null, '엑셀 ③ 과 같아야 정상');
  const rDiff = put('차이 (엑셀 ③ - 앱)',
    () => ({ formula: `B${rMat}-B${rApp}` }),
    () => ({ formula: `C${rMat}-C${rApp}` }), null, '0 이면 두 계산이 완전히 일치', '#,##0.00');
  [2, 3].forEach((c) => { ws.getRow(rDiff).getCell(c).font = { bold: true }; });

  /* ===== 자동 해석 문장 ===== */
  ws.addRow([]);
  const hInt = ws.addRow(['자동 해석 (숫자가 바뀌면 문장도 바뀝니다)']);
  hInt.getCell(1).font = { bold: true, size: 11, color: { argb: 'FFFFFFFF' } };
  hInt.getCell(1).fill = headFill('FF375623');
  ws.mergeCells(hInt.number, 1, hInt.number, 5);
  hInt.height = 20;

  // TEXT 의 "+#,##0;-#,##0" 형태는 엔진에 따라 부호가 겹쳐 보여서, 부호는 IF 로 직접 붙인다
  const sgn = (cell: string, fmt: string) => `IF(N(${cell})>=0,"+","")&TEXT(${cell},"${fmt}")`;
  const interp = [
    `="· 개당 재료비 "&TEXT(B${rUnit},"#,##0.0")&"원 → "&TEXT(C${rUnit},"#,##0.0")&"원 ("&${sgn(`D${rUnit}`, '#,##0.0')}&"원)"`,
    `=IF(N(B${rAmt})=0,"· ① 생산금액을 넣으면 원재료비율이 계산됩니다","· 원재료비율(이론) "&TEXT(B${rRate},"0.00%")&" → "&TEXT(C${rRate},"0.00%")&" ("&${sgn(`D${rRate}`, '0.00%')}&"p)")`,
    `=IF(N(B${rAct})=0,"· ⑦ ERP 실제 원재료비를 넣으면 수율/재고 효과가 분리됩니다","· 실제÷이론 "&TEXT(B${rYield},"0.0%")&" → "&TEXT(C${rYield},"0.0%")&" ("&${sgn(`D${rYield}`, '0.0%')}&"p) · 마이너스면 레시피보다 실제로 덜 투입한 것")`,
    `="· 고단가 재료비 "&${sgn(`D${rHigh}`, '#,##0')}&"원 · 생산량 비중 "&TEXT(B${rQty}*0+IF(B${rQty}=0,0,B${rHighQty}/B${rQty}),"0.0%")&" → "&TEXT(IF(C${rQty}=0,0,C${rHighQty}/C${rQty}),"0.0%")&" · 평균단가 "&${sgn(`D${rAvg}`, '0.00')}&"원/g"`,
    `=IF(B${rSup}=0,"· 제품수익성 시트에 공급가를 넣으면 믹스효과/원가율효과가 분리됩니다","· 원가율 "&TEXT(B${rRateS},"0.00%")&" → "&TEXT(C${rRateS},"0.00%")&" = 제품구성(믹스) "&${sgn(`B${rMixEff}`, '0.00%')}&"p + 제품별 원가율 "&${sgn(`C${rRateS}-B${rMix}`, '0.00%')}&"p")`,
  ];
  interp.forEach((f) => {
    const r = ws.addRow([{ formula: f.slice(1) }]);
    ws.mergeCells(r.number, 1, r.number, 5);
    r.getCell(1).font = { size: 10, color: { argb: 'FF203864' } };
    r.getCell(1).alignment = { vertical: 'middle' };
    r.height = 18;
  });

  ws.addRow([]);
  const guide = [
    '■ 쓰는 법 (노란칸만 입력하면 됩니다)',
    '  1) [요약] ① 생산금액 — 두 달치 ERP 생산금액. 넣으면 ⑤ 원재료비율이 나옵니다.',
    '  2) [요약] ⑦ ERP 실제 원재료비 — 넣으면 ⑧ 실제÷이론 이 나와서 "레시피 대비 실제로 얼마나 썼나"가 보입니다.',
    '  3) [제품수익성] 공급가(원/EA) — 넣으면 제품별 원가율, 믹스효과/원가율효과 분해, 한계이익이 전부 나옵니다.',
    '  4) [생산량]·[단가] 노란칸을 고치면 위 숫자가 전부 자동으로 다시 계산됩니다.',
    "     · [단가] 두 열에 같은 달 단가를 넣으면 '단가효과 제거(연동예산)' 이 됩니다.",
    "     · [단가] '그룹'열에 고단가 를 넣고 빼서 대상 원재료를 바꿀 수 있습니다.",
    '',
    '■ 계산식 (전부 엑셀 수식입니다 — 셀을 클릭하면 보입니다)',
    '  사용량(g)   = 개당 투입량(g) × 생산개수(EA)         … 레시피계산 I·J열',
    '  금액(원)    = 사용량(g) × 단가(원/g)                … 레시피계산 M·N열',
    '  총 원재료비 = 위 금액의 전체 합                      … 원재료집계 → 요약 ③',
    '  원재료비율  = 총 원재료비 ÷ 생산금액                 … 요약 ⑤',
    '  원가율      = 총 원재료비 ÷ (공급가 × 생산량)        … 요약 ⑱',
    '  믹스효과    = (A월 제품별 원가율 × B월 구성) - A월 원가율   … 요약 ⑳',
    '',
    '■ 읽을 때 주의',
    '  · ③ 총 원재료비는 레시피 기준 이론값입니다. ⑦ 실제와의 차이가 수율·재고 효과입니다.',
    '  · [생산량] F열이 "없음" 인 품목은 레시피가 없어 재료비 0으로 빠집니다.',
    '  · 원가율은 재료비만 본 것이라 제조원가율(노무비·경비 포함)과 다릅니다.',
  ];
  guide.forEach((g) => {
    const r = ws.addRow([g]);
    r.getCell(1).font = g.startsWith('■')
      ? { bold: true, size: 10, color: { argb: 'FF1F4E79' } }
      : { size: 9, color: { argb: 'FF404040' } };
  });

  ws.views = [{ state: 'frozen', ySplit: 4 }];

  const buf = await wb.xlsx.writeBuffer();
  return new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}
