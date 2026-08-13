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
import { findAmbientErp } from './ambientProducts';
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
  /** 제품 DB(productSettings) 의 전체 ERP 코드 목록 — 품목키를 A-001-01 형태로 표시하는 데 사용 */
  productCodes?: { code: string; name?: string }[];
  /** ERP 마감 실제 출고 (materialOutflow/{month}) — 원재료별 실제 사용량·금액 */
  outflowA?: { grams: Record<string, number>; amounts: Record<string, number> };
  outflowB?: { grams: Record<string, number>; amounts: Record<string, number> };
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
    { header: '원재료키', width: 18 },
    { header: 'ERP코드', width: 14 },
    { header: '원재료명', width: 32 },
    { header: `${monthA} 단가(원/g)`, width: 15 },
    { header: `${monthB} 단가(원/g)`, width: 15 },
    { header: '그룹(수동) ← 여기에 고단가', width: 20 },
    { header: `${monthB} 사용량(g)`, width: 15 },
    { header: `${monthB} 금액(원)`, width: 15 },
    { header: '단가 순위', width: 10 },
    { header: '사용량 순위', width: 11 },
    { header: '금액 순위', width: 10 },
    { header: '★ 적용 그룹', width: 13 },
    { header: '고단가 순번', width: 11 },
    { header: `${monthA} 단가 출처`, width: 13 },
    { header: `${monthB} 단가 출처`, width: 13 },
  ];
  styleHeader(wsPrice, 1, 'FF7030A0');
  ingList.forEach((m, i) => {
    const R = i + 2;
    const pa = priceOf(monthA, m);
    const pb = priceOf(monthB, m);
    const r = wsPrice.addRow([
      m.key, m.code, m.name, pa, pb, isHigh(m.name) ? '고단가' : '',
      { formula: `SUMIF(레시피계산!$D$2:$D$${calcLast},$A${R},레시피계산!$J$2:$J$${calcLast})` },
      { formula: `SUMIF(레시피계산!$D$2:$D$${calcLast},$A${R},레시피계산!$N$2:$N$${calcLast})` },
      { formula: `IF($E${R}=0,"",RANK($E${R},$E$2:$E$${priceLast},0))` },
      { formula: `IF($G${R}=0,"",RANK($G${R},$G$2:$G$${priceLast},0))` },
      { formula: `IF($H${R}=0,"",RANK($H${R},$H$2:$H$${priceLast},0))` },
      { formula: `IF(요약!$H$2="수동",$F${R},IF(요약!$H$2="단가 상위N",IF(N($I${R})>0,IF($I${R}<=요약!$H$3,"고단가",""),""),IF(요약!$H$2="사용량 상위N",IF(N($J${R})>0,IF($J${R}<=요약!$H$3,"고단가",""),""),IF(요약!$H$2="금액 상위N",IF(N($K${R})>0,IF($K${R}<=요약!$H$3,"고단가",""),""),""))))` },
      { formula: `IF($L${R}="고단가",COUNTIF($L$2:$L${R},"고단가"),"")` },
      { formula: `IF(N(IFERROR(VLOOKUP($A${R},원재료집계!$A$2:$L$${aggLast},10,FALSE),0))>0,"실측","기초")` },
      { formula: `IF(N(IFERROR(VLOOKUP($A${R},원재료집계!$A$2:$L$${aggLast},12,FALSE),0))>0,"실측","기초")` },
    ]);
    r.getCell(4).fill = INPUT_FILL; r.getCell(4).numFmt = '#,##0.000';
    r.getCell(5).fill = INPUT_FILL; r.getCell(5).numFmt = '#,##0.000';
    r.getCell(6).fill = INPUT_FILL; r.getCell(6).alignment = { horizontal: 'center' };
    [13, 14, 15].forEach((c) => { r.getCell(c).alignment = { horizontal: 'center' }; r.getCell(c).font = { size: 9, color: { argb: 'FF808080' } }; });
    [7, 8].forEach((c) => { r.getCell(c).numFmt = '#,##0'; });
    [9, 10, 11].forEach((c) => { r.getCell(c).numFmt = '#,##0'; r.getCell(c).alignment = { horizontal: 'center' }; });
    r.getCell(12).alignment = { horizontal: 'center' };
    r.getCell(12).font = { bold: true, color: { argb: 'FF7030A0' } };
    if (pa === 0 || pb === 0) r.getCell(3).font = { color: { argb: 'FFC00000' } };
  });
  wsPrice.views = [{ state: 'frozen', ySplit: 1 }];
  if (ingList.length > 0) wsPrice.autoFilter = { from: 'A1', to: `O${priceLast}` };

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
        { formula: `IFERROR(VLOOKUP($D${R},단가!$A$2:$L$${priceLast},12,FALSE),"")` },
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
    { header: '고단가 포함', width: 11 },
    { header: '공급가(원/EA) ← 입력', width: 18 },
    { header: '권장소비자가 ← 입력', width: 17 },
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
    { header: `${monthA} 고단가 재료비`, width: 16 },
    { header: `${monthB} 고단가 재료비`, width: 16 },
    { header: '앱 내부키', width: 24 },
  ];
  styleHeader(wsPro, 1, 'FFC55A11');
  products.forEach((p, i) => {
    const R = i + 2;
    const row = wsPro.addRow([
      p.key, p.name, p.kind,
      { formula: `IF(COUNTIFS(레시피계산!$A$2:$A$${calcLast},$A${R},레시피계산!$O$2:$O$${calcLast},"고단가")>0,"O","")` },
      null,   // 공급가 — 사용자가 VLOOKUP/직접 입력
      null,   // 권장소비자가
      { formula: `IFERROR(VLOOKUP($A${R},생산량!$A$2:$E$${qtyLast},4,FALSE),0)` },
      { formula: `IFERROR(VLOOKUP($A${R},생산량!$A$2:$E$${qtyLast},5,FALSE),0)` },
      { formula: `SUMIF(레시피계산!$A$2:$A$${calcLast},$A${R},레시피계산!$M$2:$M$${calcLast})` },
      { formula: `SUMIF(레시피계산!$A$2:$A$${calcLast},$A${R},레시피계산!$N$2:$N$${calcLast})` },
      { formula: `IF($G${R}=0,"",$I${R}/$G${R})` },
      { formula: `IF($H${R}=0,"",$J${R}/$H${R})` },
      { formula: `$E${R}*$G${R}` },
      { formula: `$E${R}*$H${R}` },
      { formula: `IF($M${R}=0,"",$I${R}/$M${R})` },
      { formula: `IF($N${R}=0,"",$J${R}/$N${R})` },
      { formula: `IF(SUM($N$2:$N$${profitLast})=0,"",$N${R}/SUM($N$2:$N$${profitLast}))` },
      { formula: `IF(OR($O${R}="",$Q${R}=""),0,$O${R}*$Q${R})` },
      { formula: `IF($N${R}=0,"",$N${R}-$J${R})` },
      { formula: `SUMIFS(레시피계산!$M$2:$M$${calcLast},레시피계산!$A$2:$A$${calcLast},$A${R},레시피계산!$O$2:$O$${calcLast},"고단가")` },
      { formula: `SUMIFS(레시피계산!$N$2:$N$${calcLast},레시피계산!$A$2:$A$${calcLast},$A${R},레시피계산!$O$2:$O$${calcLast},"고단가")` },
      p.shortCode,
    ]);
    row.getCell(4).alignment = { horizontal: 'center' };
    [5, 6].forEach((c) => { row.getCell(c).fill = INPUT_FILL; row.getCell(c).numFmt = '#,##0'; });
    [7, 8, 9, 10, 13, 14, 19, 20, 21].forEach((c) => { row.getCell(c).numFmt = '#,##0'; });
    [11, 12].forEach((c) => { row.getCell(c).numFmt = '#,##0.0'; });
    [15, 16, 17, 18].forEach((c) => { row.getCell(c).numFmt = '0.00%'; });
  });
  wsPro.views = [{ state: 'frozen', ySplit: 1 }];
  if (products.length > 0) wsPro.autoFilter = { from: 'A1', to: `V${profitLast}` };

  /** ERP 실제 출고 조회 — 저장 키가 코드접두사/이름 두 형태라 둘 다 시도 */
  const outOf = (
    src: { grams: Record<string, number>; amounts: Record<string, number> } | undefined,
    key: string,
    which: 'grams' | 'amounts',
  ): number | null => {
    if (!src) return null;
    const m = src[which] || {};
    const v = m[CODE_KEY_PREFIX + key] ?? m[key] ?? m[normalizeMaterialName(key)];
    return v && v > 0 ? v : null;
  };

  /* ================= 원재료집계 ================= */
  const wsAgg = wb.addWorksheet('원재료집계');
  wsAgg.columns = [
    { header: '원재료키', width: 18 },
    { header: '원재료명', width: 32 },
    { header: '그룹', width: 10 },
    { header: `${monthA} 이론 사용량(g)`, width: 17 },
    { header: `${monthB} 이론 사용량(g)`, width: 17 },
    { header: `${monthA} 이론 금액`, width: 16 },
    { header: `${monthB} 이론 금액`, width: 16 },
    { header: '이론 금액 증감', width: 16 },
    { header: '증감률', width: 10 },
    { header: `${monthA} 실제 출고(g)`, width: 17 },
    { header: `${monthA} 실제 금액`, width: 16 },
    { header: `${monthB} 실제 출고(g)`, width: 17 },
    { header: `${monthB} 실제 금액`, width: 16 },
    { header: `${monthA} 실제÷이론`, width: 14 },
    { header: `${monthB} 실제÷이론`, width: 14 },
    { header: '실제 금액 증감', width: 16 },
  ];
  styleHeader(wsAgg, 1, 'FF548235');
  ingList.forEach((m, i) => {
    const R = i + 2;
    const row = wsAgg.addRow([
      m.key, m.name,
      { formula: `IFERROR(VLOOKUP($A${R},단가!$A$2:$L$${priceLast},12,FALSE),"")` },
      { formula: `SUMIF(레시피계산!$D$2:$D$${calcLast},$A${R},레시피계산!$I$2:$I$${calcLast})` },
      { formula: `SUMIF(레시피계산!$D$2:$D$${calcLast},$A${R},레시피계산!$J$2:$J$${calcLast})` },
      { formula: `SUMIF(레시피계산!$D$2:$D$${calcLast},$A${R},레시피계산!$M$2:$M$${calcLast})` },
      { formula: `SUMIF(레시피계산!$D$2:$D$${calcLast},$A${R},레시피계산!$N$2:$N$${calcLast})` },
      { formula: `$G${R}-$F${R}` },
      { formula: `IF($F${R}=0,"",$G${R}/$F${R}-1)` },
      outOf(inp.outflowA, m.key, 'grams'),
      outOf(inp.outflowA, m.key, 'amounts'),
      outOf(inp.outflowB, m.key, 'grams'),
      outOf(inp.outflowB, m.key, 'amounts'),
      { formula: `IF(OR(N($D${R})=0,N($J${R})=0),"",$J${R}/$D${R})` },
      { formula: `IF(OR(N($E${R})=0,N($L${R})=0),"",$L${R}/$E${R})` },
      { formula: `IF(OR(N($K${R})=0,N($M${R})=0),"",$M${R}-$K${R})` },
    ]);
    [4, 5, 6, 7, 8, 10, 11, 12, 13, 16].forEach((c) => { row.getCell(c).numFmt = '#,##0'; });
    row.getCell(9).numFmt = '0.0%';
    [10, 11, 12, 13].forEach((c) => { row.getCell(c).fill = INPUT_FILL; });
    [14, 15].forEach((c) => { row.getCell(c).numFmt = '0.0%'; });
  });
  wsAgg.views = [{ state: 'frozen', ySplit: 1 }];
  if (ingList.length > 0) wsAgg.autoFilter = { from: 'A1', to: `P${aggLast}` };

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
  const rGram = put('③-1 총 원재료 사용량 (g)',
    () => ({ formula: `SUM(원재료집계!D2:D${aggLast})` }),
    () => ({ formula: `SUM(원재료집계!E2:E${aggLast})` }),
    dBC, '레시피 × 생산량 (전체 원재료)');
  const rUnitG = put('③-2 전체 원단위 (g/EA)',
    () => ({ formula: `IF(B${rQty}=0,"",B${rGram}/B${rQty})` }),
    () => ({ formula: `IF(C${rQty}=0,"",C${rGram}/C${rQty})` }),
    dBC, '③-1 ÷ ② — 고단가 원단위(㉔)와 비교하세요', '#,##0.00');
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
  const rActAuto = put('⑦-0 실제 출고 합계 (원재료집계 자동)',
    () => ({ formula: `SUM(원재료집계!K2:K${aggLast})` }),
    () => ({ formula: `SUM(원재료집계!M2:M${aggLast})` }),
    dBC, '원재료집계의 ERP 실제 금액 합계 — 0이면 실제 출고 데이터가 없는 것');
  // 비워두면 ⑦-0(자동 합계)을 쓰고, 값을 넣으면 그 값이 우선한다
  const rAct = put('⑦ ERP 실제 원재료비 (원)  ← 직접 넣을 때만',
    () => null, () => null, dBC,
    '비워두면 ⑦-0 을 그대로 사용합니다. ERP 총액이 따로 있으면 여기에 넣으세요', '#,##0', true);
  const actB = `IF(N(B${rAct})>0,B${rAct},B${rActAuto})`;
  const actC = `IF(N(C${rAct})>0,C${rAct},C${rActAuto})`;
  const rYield = put('⑧ 실제 ÷ 이론 (금액)',
    () => ({ formula: `IF(N(${actB})=0,"",${actB}/B${rMat})` }),
    () => ({ formula: `IF(N(${actC})=0,"",${actC}/C${rMat})` }),
    dBC, '100% 미만 = 레시피보다 덜 투입 (수율↑ 또는 재고 영향)', '0.0%');
  const rActG = put('⑧-1 실제 출고량 (g)',
    () => ({ formula: `SUM(원재료집계!J2:J${aggLast})` }),
    () => ({ formula: `SUM(원재료집계!L2:L${aggLast})` }),
    dBC, '원재료집계의 ERP 실제 출고량 합계');
  put('⑧-1b 실제 ÷ 이론 (수량)',
    () => ({ formula: `IF(OR(B${rActG}=0,B${rGram}=0),"",B${rActG}/B${rGram})` }),
    () => ({ formula: `IF(OR(C${rActG}=0,C${rGram}=0),"",C${rActG}/C${rGram})` }),
    dBC, '⑧(금액)과 크게 다르면 출고 단위(g/kg)나 반제품 펼침 차이를 의심하세요', '0.0%');
  put('⑧-2 실제 원단위 (g/EA)',
    () => ({ formula: `IF(OR(B${rActG}=0,B${rQty}=0),"",B${rActG}/B${rQty})` }),
    () => ({ formula: `IF(OR(C${rActG}=0,C${rQty}=0),"",C${rActG}/C${rQty})` }),
    dBC, '실제 출고량 ÷ 생산량 — 이론 원단위(③-2)와 비교', '#,##0.00');
  put('⑨ 실제 기준 원재료비율',
    () => ({ formula: `IF(OR(N(${actB})=0,N(B${rAmt})=0),"",${actB}/B${rAmt})` }),
    () => ({ formula: `IF(OR(N(${actC})=0,N(C${rAmt})=0),"",${actC}/C${rAmt})` }),
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
  put('⑮ 고단가 평균단가 (원/g)',
    () => ({ formula: `IF(B${rHighG}=0,"",B${rHigh}/B${rHighG})` }),
    () => ({ formula: `IF(C${rHighG}=0,"",C${rHigh}/C${rHighG})` }),
    dBC, '올라가면 = 고단가 안에서 더 비싼 원재료 쪽으로 이동', '#,##0.00');

  ws.addRow([]);
  section('제품 공급가 기준 (제품수익성 시트에 공급가 입력 시)', 'FFC55A11');
  const supSum = (col: 'M' | 'N') => `SUM(제품수익성!$${col}$2:$${col}$${profitLast})`;
  const rSup = put('⑯ 공급가액 합계 (자동)',
    () => ({ formula: `${supSum('M')}` }), () => ({ formula: `${supSum('N')}` }), dBC,
    '제품별 공급가 × 생산량 — ①과 비슷해야 정상');
  put('⑰ ① 대비 차이',
    () => ({ formula: `IF(OR(N(B${rAmt})=0,B${rSup}=0),"",B${rSup}-B${rAmt})` }),
    () => ({ formula: `IF(OR(N(C${rAmt})=0,C${rSup}=0),"",C${rSup}-C${rAmt})` }),
    null, '공급가 입력이 맞는지 확인용');
  put('⑰-1 공급가 미입력 품목 (EA)',
    () => ({ formula: `SUMPRODUCT(--(제품수익성!$E$2:$E$${profitLast}=0),제품수익성!$G$2:$G$${profitLast})` }),
    () => ({ formula: `SUMPRODUCT(--(제품수익성!$E$2:$E$${profitLast}=0),제품수익성!$H$2:$H$${profitLast})` }),
    null, '공급가를 안 넣은 제품의 생산량 — 0 이어야 ⑯이 완전합니다');
  const rRateS = put('⑱ 원가율 (공급가 기준)',
    () => ({ formula: `IF(B${rSup}=0,"",B${rMat}/B${rSup})` }),
    () => ({ formula: `IF(C${rSup}=0,"",C${rMat}/C${rSup})` }),
    dBC, '③ ÷ ⑯', '0.00%');
  const rMix = put('⑲ 믹스 기준 원가율',
    () => ({ formula: `IF(B${rSup}=0,"",SUM(제품수익성!$R$2:$R$${profitLast}))` }),
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
    () => ({ formula: `IF(B${rSup}=0,"",SUM(제품수익성!$S$2:$S$${profitLast}))` }),
    () => null, null, '재료비만 뺀 값 (노무비·경비 제외)');

  ws.addRow([]);
  section('고단가 원재료 — 적게 썼나 / 비싼 제품을 만들었나', 'FF203864');
  const proSum = (col: string, flag = true) =>
    flag
      ? `SUMIF(제품수익성!$D$2:$D$${profitLast},"O",제품수익성!$${col}$2:$${col}$${profitLast})`
      : `SUM(제품수익성!$${col}$2:$${col}$${profitLast})`;

  // ── 사용 강도 (얼마나 썼나) : 전체 생산 1EA 당
  const rIntG = put('㉔ 고단가 원단위 (g/EA)',
    () => ({ formula: `IF(B${rQty}=0,"",B${rHighG}/B${rQty})` }),
    () => ({ formula: `IF(C${rQty}=0,"",C${rHighG}/C${rQty})` }),
    dBC, '고단가 사용량 ÷ 전체 생산량 — 내려가면 덜 쓴 것', '#,##0.00');
  const rIntW = put('㉕ 고단가 원단위 (원/EA)',
    () => ({ formula: `IF(B${rQty}=0,"",B${rHigh}/B${rQty})` }),
    () => ({ formula: `IF(C${rQty}=0,"",C${rHigh}/C${rQty})` }),
    dBC, '고단가 재료비 ÷ 전체 생산량', '#,##0.0');

  // ── 판매 가치 (얼마에 파나)
  const rHiSup = put('㉖ 고단가 제품 공급가액',
    () => ({ formula: proSum('M') }), () => ({ formula: proSum('N') }), dBC,
    '고단가 원재료가 들어간 제품의 공급가액 합계');
  put('㉗ 고단가 제품 매출비중',
    () => ({ formula: `IF(B${rSup}=0,"",B${rHiSup}/B${rSup})` }),
    () => ({ formula: `IF(C${rSup}=0,"",C${rHiSup}/C${rSup})` }),
    dBC, '㉖ ÷ ⑯ — 생산량 비중(⑭)과 비교해 보세요', '0.00%');
  const rHiPrice = put('㉘ 고단가 제품 평균 공급가 (원/EA)',
    () => ({ formula: `IF(B${rHighQty}=0,"",B${rHiSup}/B${rHighQty})` }),
    () => ({ formula: `IF(C${rHighQty}=0,"",C${rHiSup}/C${rHighQty})` }),
    dBC, '올라가면 = 같은 고단가 제품군 안에서 비싼 제품을 더 만든 것');
  put('㉙ 그 외 제품 평균 공급가 (원/EA)',
    () => ({ formula: `IF(B${rQty}-B${rHighQty}=0,"",(B${rSup}-B${rHiSup})/(B${rQty}-B${rHighQty}))` }),
    () => ({ formula: `IF(C${rQty}-C${rHighQty}=0,"",(C${rSup}-C${rHiSup})/(C${rQty}-C${rHighQty}))` }),
    dBC, '고단가 제품과 비교용');

  // ── 수익성
  const rHiMat = put('㉚ 고단가 제품 총재료비',
    () => ({ formula: proSum('I') }), () => ({ formula: proSum('J') }), dBC,
    '고단가 제품의 전체 재료비 (고단가 원재료만이 아님)');
  const rHiRate = put('㉛ 고단가 제품 원가율',
    () => ({ formula: `IF(B${rHiSup}=0,"",B${rHiMat}/B${rHiSup})` }),
    () => ({ formula: `IF(C${rHiSup}=0,"",C${rHiMat}/C${rHiSup})` }),
    dBC, '㉚ ÷ ㉖ — 고단가 제품군만의 원가율', '0.00%');
  put('㉜ 그 외 제품 원가율',
    () => ({ formula: `IF(B${rSup}-B${rHiSup}=0,"",(B${rMat}-B${rHiMat})/(B${rSup}-B${rHiSup}))` }),
    () => ({ formula: `IF(C${rSup}-C${rHiSup}=0,"",(C${rMat}-C${rHiMat})/(C${rSup}-C${rHiSup}))` }),
    dBC, '고단가 제품군과 비교용', '0.00%');
  const rMsrp = put('㉝ 공급가 ÷ 권장소비자가 (가중평균)',
    () => ({ formula: `IF(SUMPRODUCT(제품수익성!$F$2:$F$${profitLast},제품수익성!$G$2:$G$${profitLast})=0,"",SUMPRODUCT(제품수익성!$E$2:$E$${profitLast},제품수익성!$G$2:$G$${profitLast})/SUMPRODUCT(제품수익성!$F$2:$F$${profitLast},제품수익성!$G$2:$G$${profitLast}))` }),
    () => ({ formula: `IF(SUMPRODUCT(제품수익성!$F$2:$F$${profitLast},제품수익성!$H$2:$H$${profitLast})=0,"",SUMPRODUCT(제품수익성!$E$2:$E$${profitLast},제품수익성!$H$2:$H$${profitLast})/SUMPRODUCT(제품수익성!$F$2:$F$${profitLast},제품수익성!$H$2:$H$${profitLast}))` }),
    dBC, '권장소비자가를 넣으면 계산됩니다 (예: 2,652 ÷ 3,900 = 68%)', '0.00%');

  ws.addRow([]);
  section('검증', 'FF808080');
  const rApp = put('앱(MES) 계산값', () => inp.appTotalA, () => inp.appTotalB, null, '엑셀 ③ 과 같아야 정상');
  const rDiff = put('차이 (엑셀 ③ - 앱)',
    () => ({ formula: `B${rMat}-B${rApp}` }),
    () => ({ formula: `C${rMat}-C${rApp}` }), null, '0 이면 두 계산이 완전히 일치', '#,##0.00');
  [2, 3].forEach((c) => { ws.getRow(rDiff).getCell(c).font = { bold: true }; });

  /* ===== 자동 해석 문장 ===== */
  /* ===== 우측 패널: 고단가 선택 방식 + 전체 vs 고단가 비교 ===== */
  ws.getColumn(7).width = 22;   // G
  [8, 9, 10, 11, 12].forEach((c) => { ws.getColumn(c).width = 17; });

  const gc = (r: number, c: number) => ws.getRow(r).getCell(c);
  const panelHead = (r: number, c1: number, c2: number, text: string, argb: string) => {
    ws.mergeCells(r, c1, r, c2);
    const cell = gc(r, c1);
    cell.value = text;
    cell.font = { bold: true, size: 11, color: { argb: 'FFFFFFFF' } };
    cell.fill = headFill(argb);
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
    for (let c = c1; c <= c2; c += 1) gc(r, c).border = BORDER;
  };

  // 선택 방식 (단가 시트 '적용 그룹' 열이 이 두 칸을 봅니다)
  panelHead(1, 7, 12, '고단가 원재료 선택 방식', 'FF7030A0');
  gc(2, 7).value = '선택 방식';
  gc(3, 7).value = '상위 N개';
  [2, 3].forEach((r) => { gc(r, 7).font = { bold: true }; gc(r, 7).border = BORDER; });
  gc(2, 8).value = '수동';
  gc(3, 8).value = 10;
  [2, 3].forEach((r) => { gc(r, 8).fill = INPUT_FILL; gc(r, 8).border = BORDER; gc(r, 8).alignment = { horizontal: 'center' }; });
  gc(2, 8).dataValidation = {
    type: 'list', allowBlank: false, showErrorMessage: true,
    formulae: ['"수동,단가 상위N,사용량 상위N,금액 상위N"'],
  };
  ws.mergeCells(2, 9, 2, 12);
  gc(2, 9).value = "수동 = [단가] 시트 '그룹(수동)' 열에 직접 고단가 라고 적은 것만";
  gc(2, 9).font = NOTE;
  ws.mergeCells(3, 9, 3, 12);
  gc(3, 9).value = '상위N = [단가] 시트에서 자동으로 상위 N개를 고단가로 잡음';
  gc(3, 9).font = NOTE;

  // 전체 vs 고단가
  panelHead(5, 7, 12, '전체 vs 고단가 한눈 비교', 'FF203864');
  const cmpHdr = ['구분', `전체 ${monthA}`, `전체 ${monthB}`, `고단가 ${monthA}`, `고단가 ${monthB}`, `고단가 비중 ${monthB}`];
  cmpHdr.forEach((h, i) => {
    const cell = gc(6, 7 + i);
    cell.value = h;
    cell.font = { bold: true, size: 10, color: { argb: 'FFFFFFFF' } };
    cell.fill = headFill('FF44546A');
    cell.alignment = { horizontal: 'center', wrapText: true };
    cell.border = BORDER;
  });
  ws.getRow(6).height = 20;

  const cmpRows: { label: string; all: [string, string]; hi: [string, string]; fmt: string; share: boolean }[] = [
    { label: '재료비 (원)', all: [`B${rMat}`, `C${rMat}`], hi: [`B${rHigh}`, `C${rHigh}`], fmt: '#,##0', share: true },
    { label: '사용량 (g)', all: [`B${rGram}`, `C${rGram}`], hi: [`B${rHighG}`, `C${rHighG}`], fmt: '#,##0', share: true },
    { label: '생산량 (EA)', all: [`B${rQty}`, `C${rQty}`], hi: [`B${rHighQty}`, `C${rHighQty}`], fmt: '#,##0', share: true },
    { label: '원단위 (원/EA)', all: [`B${rUnit}`, `C${rUnit}`], hi: [`B${rIntW}`, `C${rIntW}`], fmt: '#,##0.0', share: false },
    { label: '원단위 (g/EA)', all: [`B${rUnitG}`, `C${rUnitG}`], hi: [`B${rIntG}`, `C${rIntG}`], fmt: '#,##0.00', share: false },
    { label: '공급가액 (원)', all: [`B${rSup}`, `C${rSup}`], hi: [`B${rHiSup}`, `C${rHiSup}`], fmt: '#,##0', share: true },
    { label: '평균 공급가 (원/EA)', all: [`IF(B${rQty}=0,"",B${rSup}/B${rQty})`, `IF(C${rQty}=0,"",C${rSup}/C${rQty})`], hi: [`B${rHiPrice}`, `C${rHiPrice}`], fmt: '#,##0', share: false },
    { label: '원가율', all: [`B${rRateS}`, `C${rRateS}`], hi: [`B${rHiRate}`, `C${rHiRate}`], fmt: '0.00%', share: false },
  ];
  cmpRows.forEach((cr, i) => {
    const R = 7 + i;
    gc(R, 7).value = cr.label;
    gc(R, 7).font = { bold: true, size: 10 };
    const put4 = (col: number, ref: string) => {
      const cell = gc(R, col);
      cell.value = { formula: ref.includes('(') || ref.includes('/') ? ref : `${ref}` } as ExcelJS.CellValue;
      cell.numFmt = cr.fmt;
    };
    put4(8, cr.all[0]); put4(9, cr.all[1]); put4(10, cr.hi[0]); put4(11, cr.hi[1]);
    const shareCell = gc(R, 12);
    shareCell.value = { formula: `IF(N(${cr.all[1]})=0,"",${cr.hi[1]}/${cr.all[1]})` };
    shareCell.numFmt = '0.0%';
    shareCell.font = { size: 10, color: { argb: 'FF7030A0' } };
    for (let c = 7; c <= 12; c += 1) gc(R, c).border = BORDER;
  });
  const noteR = 7 + cmpRows.length;
  ws.mergeCells(noteR, 7, noteR, 12);
  gc(noteR, 7).value = '※ 마지막 열 = 고단가 ÷ 전체 (모든 행 동일 기준). 원가율·평균공급가 행은 100%보다 크면 고단가 쪽이 더 높다는 뜻입니다.';
  gc(noteR, 7).font = NOTE;
  gc(noteR, 7).alignment = { wrapText: true };

  // ── 지금 고단가로 잡힌 원재료 목록 (선택 방식이 바뀌면 같이 바뀜)
  const LIST_TOP = noteR + 2;
  const LIST_N = 25;
  panelHead(LIST_TOP, 7, 12, '지금 고단가로 잡힌 원재료', 'FF7030A0');
  ws.mergeCells(LIST_TOP + 1, 7, LIST_TOP + 1, 12);
  gc(LIST_TOP + 1, 7).value = {
    formula: `"총 "&COUNTIF(단가!$L$2:$L$${priceLast},"고단가")&"개 · 선택 방식: "&$H$2&IF($H$2="수동",""," (상위 "&$H$3&"개)")&"   — 아래 "&${LIST_N}&"개까지 표시"`,
  };
  gc(LIST_TOP + 1, 7).font = { size: 10, bold: true, color: { argb: 'FF7030A0' } };
  const listHdr = ['#', '원재료명', `${monthB} 단가(원/g)`, `${monthB} 사용량(g)`, `${monthB} 금액(원)`, '전체 재료비 대비'];
  listHdr.forEach((h, i) => {
    const cell = gc(LIST_TOP + 2, 7 + i);
    cell.value = h;
    cell.font = { bold: true, size: 10, color: { argb: 'FFFFFFFF' } };
    cell.fill = headFill('FF7030A0');
    cell.alignment = { horizontal: 'center', wrapText: true };
    cell.border = BORDER;
  });
  for (let i = 0; i < LIST_N; i += 1) {
    const R = LIST_TOP + 3 + i;
    const n = i + 1;
    const pick = (col: string) => `IFERROR(INDEX(단가!$${col}$2:$${col}$${priceLast},MATCH(${n},단가!$M$2:$M$${priceLast},0)),"")`;
    gc(R, 7).value = { formula: `IF(${n}>COUNTIF(단가!$L$2:$L$${priceLast},"고단가"),"",${n})` };
    gc(R, 8).value = { formula: pick('C') };
    gc(R, 9).value = { formula: pick('E') };
    gc(R, 10).value = { formula: pick('G') };
    gc(R, 11).value = { formula: pick('H') };
    gc(R, 12).value = { formula: `IF(OR(N(C${rMat})=0,N(${pick('H')})=0),"",${pick('H')}/C${rMat})` };
    gc(R, 7).alignment = { horizontal: 'center' };
    gc(R, 9).numFmt = '#,##0.000';
    [10, 11].forEach((c) => { gc(R, c).numFmt = '#,##0'; });
    gc(R, 12).numFmt = '0.00%';
    for (let c = 7; c <= 12; c += 1) gc(R, c).border = BORDER;
  }
  const listEnd = LIST_TOP + 3 + LIST_N;
  ws.mergeCells(listEnd, 7, listEnd, 12);
  gc(listEnd, 7).value = '※ 바꾸려면 위 H2(선택 방식)·H3(상위 N개)를 조정하거나, [단가] 시트 F열에 직접 고단가 라고 적으세요.';
  gc(listEnd, 7).font = NOTE;

  ws.addRow([]);
  const hInt = ws.addRow(['자동 해석 (숫자가 바뀌면 문장도 바뀝니다)']);
  hInt.getCell(1).font = { bold: true, size: 11, color: { argb: 'FFFFFFFF' } };
  hInt.getCell(1).fill = headFill('FF375623');
  ws.mergeCells(hInt.number, 1, hInt.number, 5);
  hInt.height = 20;

  // TEXT 의 "+#,##0;-#,##0" 형태는 엔진에 따라 부호가 겹쳐 보여서, 부호는 IF 로 직접 붙인다
  const sgn = (cell: string, fmt: string) => `IF(N(${cell})>=0,"+","")&TEXT(${cell},"${fmt}")`;
  const interp = [
    `="① 개당 재료비(이론)  "&TEXT(B${rUnit},"#,##0.0")&"원 → "&TEXT(C${rUnit},"#,##0.0")&"원  ("&${sgn(`D${rUnit}`, '#,##0.0')}&"원)"`,
    `=IF(N(B${rAmt})=0,"② 원재료비율 — ① 생산금액을 넣으면 계산됩니다","② 원재료비율(이론)  "&TEXT(B${rRate},"0.00%")&" → "&TEXT(C${rRate},"0.00%")&"  ("&${sgn(`D${rRate}`, '0.00%')}&"p)  ※ 분모는 ① 생산금액")`,
    `=IF(N(${actB})=0,"③ 이론 대비 실제 — ⑦ 실제 원재료비가 있어야 계산됩니다","③ 실제÷이론  "&TEXT(B${rYield},"0.0%")&" → "&TEXT(C${rYield},"0.0%")&"  ("&${sgn(`D${rYield}`, '0.0%')}&"p)   100%보다 낮으면 레시피 이론치보다 실제로 덜 나간 것(수율·재고 영향)")`,
    `="④ 고단가 사용 강도  "&TEXT(B${rIntG},"0.00")&" → "&TEXT(C${rIntG},"0.00")&" g/EA ("&${sgn(`D${rIntG}`, '0.00')}&"),  "&TEXT(B${rIntW},"#,##0.0")&" → "&TEXT(C${rIntW},"#,##0.0")&" 원/EA ("&${sgn(`D${rIntW}`, '0.0')}&")   ※ 전체 생산 1EA 기준"`,
    `=IF(B${rHiPrice}="","⑤ 고단가 제품 판매단가 — 제품수익성 E열에 공급가를 넣어야 계산됩니다","⑤ 고단가 제품 평균 공급가  "&TEXT(B${rHiPrice},"#,##0")&" → "&TEXT(C${rHiPrice},"#,##0")&" 원/EA ("&${sgn(`D${rHiPrice}`, '#,##0')}&", "&${sgn(`IF(N(B${rHiPrice})=0,0,D${rHiPrice}/B${rHiPrice})`, '0.0%')}&")")`,
    // 판정 — 각 축이 1% 이상 움직였을 때만 방향으로 인정 (미세 변동을 성과로 읽지 않기)
    `=IF(B${rHiPrice}="","",` +
      `LET_PLACEHOLDER)`,
    `=IF(B${rMsrp}="","","⑦ 공급가율(공급가÷권장소비자가)  "&TEXT(B${rMsrp},"0.0%")&" → "&TEXT(C${rMsrp},"0.0%")&IF(OR(B${rMsrp}>1,C${rMsrp}>1)," ⚠ 100%를 넘습니다 — 제품수익성 E열(공급가)과 F열(권장소비자가)이 바뀐 것 같습니다",""))`,
    `=IF(OR(N(B${rSup})=0,N(B${rAmt})=0),"","⑧ 검산: 공급가액 합계 "&TEXT(B${rSup},"#,##0")&" vs ① 생산금액 "&TEXT(B${rAmt},"#,##0")&"  → 차이 "&TEXT(ABS(B${rSup}/B${rAmt}-1),"0.0%")&IF(ABS(B${rSup}/B${rAmt}-1)>0.05," ⚠ 5% 넘게 벌어집니다. 공급가 단위(1EA인지)와 열 위치를 확인하세요"," ✓ 정상 범위"))`,
    `=IF(B${rSup}=0,"","⑨ 원가율 "&TEXT(B${rRateS},"0.00%")&" → "&TEXT(C${rRateS},"0.00%")&"  =  제품구성(믹스) "&${sgn(`B${rMixEff}`, '0.00%')}&"p  +  제품별 원가율 "&${sgn(`C${rRateS}-B${rMix}`, '0.00%')}&"p")`,
  ];

  // 판정문: 사용 강도(㉕)와 판매단가(㉘) 변화율을 각각 ±1% 기준으로 판단
  const relW = `IF(N(B${rIntW})=0,0,D${rIntW}/B${rIntW})`;
  const relP = `IF(N(B${rHiPrice})=0,0,D${rHiPrice}/B${rHiPrice})`;
  const verdict =
    `IF(AND(ABS(${relW})<0.01,ABS(${relP})<0.01),"⑥ 판정: 두 지표 모두 사실상 변화 없음 (±1% 이내) — 고단가 쪽 요인은 아닙니다",` +
    `IF(AND(${relW}<=-0.01,${relP}>=0.01),"⑥ 판정: 고단가를 덜 쓰면서 판매단가가 높은 제품을 더 만들었습니다 (원가율 개선의 질이 좋음)",` +
    `IF(AND(${relW}<=-0.01,ABS(${relP})<0.01),"⑥ 판정: 고단가 투입만 줄었습니다 (판매단가는 그대로 — 단순 절감 또는 레시피/수율 요인)",` +
    `IF(AND(${relW}<=-0.01,${relP}<=-0.01),"⑥ 판정: 고단가도 덜 쓰고 판매단가도 낮아졌습니다 (저가 제품 쪽으로 이동 — 원가율은 좋아 보여도 매출은 확인 필요)",` +
    `IF(AND(${relW}>=0.01,${relP}>=0.01),"⑥ 판정: 고단가를 더 썼지만 판매단가도 같이 올랐습니다 (고급화 — ㉛ 고단가 제품 원가율로 득실 확인)",` +
    `IF(AND(${relW}>=0.01,${relP}<=-0.01),"⑥ 판정: 고단가를 더 쓰고 판매단가는 낮아졌습니다 (원가 악화)",` +
    `IF(${relW}>=0.01,"⑥ 판정: 고단가 투입만 늘었습니다 (판매단가는 그대로)",` +
    `"⑥ 판정: 고단가 투입은 그대로인데 판매단가가 "&IF(${relP}>0,"올랐습니다 (제품 구성 개선)","낮아졌습니다 (제품 구성 악화)"))))))))`;
  interp[5] = interp[5].replace('LET_PLACEHOLDER', verdict);

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
    '  3) [제품수익성] E열 공급가(원/EA)·F열 권장소비자가 — 직접 입력하거나 VLOOKUP 으로 채우세요.',
    '     넣으면 제품별 원가율, 믹스효과/원가율효과 분해,',
    '     한계이익, 그리고 ㉔~㉝ "고단가를 덜 썼나 / 비싼 제품을 만들었나" 지표가 전부 나옵니다.',
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
    '  고단가 원단위 = 고단가 사용량 ÷ 전체 생산량                  … 요약 ㉔ (얼마나 썼나)',
    '  고단가 제품 평균 공급가 = 고단가 제품 공급가액 ÷ 그 제품 생산량 … 요약 ㉘ (얼마에 파나)',
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
