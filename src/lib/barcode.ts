/** 제품 바코드 — Firestore `productBarcodes/{바코드}` = { barcode, code, name, updatedAt } */

export const BARCODE_COL = 'productBarcodes';

export interface ProductBarcode {
  barcode: string;
  code: string;
  name: string;
  updatedAt?: number;
}

/** 리더기가 붙이는 공백·제어문자·전각 숫자 정리. 영문은 대문자로 통일 */
export function normalizeBarcode(raw: string): string {
  return (raw || '')
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[\s\u0000-\u001f\u007f]/g, '')
    .toUpperCase();
}

/** GTIN(EAN-8 / UPC-A 12 / EAN-13 / GTIN-14) 체크디지트 검사.
 *  숫자이면서 이 길이가 아니면 null (검사 대상 아님) */
export function gtinCheck(code: string): boolean | null {
  if (!/^\d+$/.test(code) || ![8, 12, 13, 14].includes(code.length)) return null;
  const digits = code.split('').map(Number);
  const check = digits.pop()!;
  let sum = 0;
  // 오른쪽(체크디지트 바로 앞)부터 ×3, ×1 번갈아
  for (let i = digits.length - 1, w = 3; i >= 0; i--, w = w === 3 ? 1 : 3) sum += digits[i] * w;
  return (10 - (sum % 10)) % 10 === check;
}

/** 같은 상품이 UPC-A(12) · EAN-13(0+12) · GTIN-14(0+13) 로 찍힐 수 있어 후보를 같이 본다 */
export function barcodeVariants(code: string): string[] {
  const out = [code];
  if (/^\d+$/.test(code)) {
    let s = code;
    while (s.length > 8 && s.startsWith('0')) { s = s.slice(1); out.push(s); }
    if (code.length === 12) out.push('0' + code);
    if (code.length === 13) out.push('0' + code);
  }
  return [...new Set(out)];
}

/** 붙여넣기 한 줄 → 제품코드 / 제품명 / 바코드.
 *  탭이 있으면 탭으로만 자르고(제품명 속 공백 보존), 없으면 첫 토큰=코드 · 끝 토큰=바코드 · 가운데=제품명 */
export function parseBarcodeLine(line: string): ProductBarcode | null {
  const t = line.replace(/\r/g, '').trim();
  if (!t) return null;
  let cols: string[];
  if (t.includes('\t')) cols = t.split('\t').map((s) => s.trim());
  else if (t.includes(',')) cols = t.split(',').map((s) => s.trim());
  else {
    const parts = t.split(/\s+/);
    if (parts.length < 3) return null;
    cols = [parts[0], parts.slice(1, -1).join(' '), parts[parts.length - 1]];
  }
  cols = cols.filter((c, i) => c !== '' || i === 1);
  if (cols.length < 3) return null;
  const code = cols[0].trim();
  const barcode = normalizeBarcode(cols[cols.length - 1]);
  const name = cols.slice(1, -1).join(' ').trim();
  if (!code || !barcode) return null;
  return { code, name, barcode };
}
