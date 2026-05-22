/** ERP 형식(A-001-01, F-528-01)을 단축 형식(A01, F528)으로 변환 (하이픈 없음) */
export function convertErpCode(raw: string): string {
  const m = (raw || '').trim().match(/^([A-Za-z])-(\d+)-\d+$/);
  if (!m) return (raw || '').trim();
  const letter = m[1].toUpperCase();
  const num = String(parseInt(m[2], 10)).padStart(2, '0');
  return `${letter}${num}`;
}

/** 비교용 정규화: 대시·공백 제거 + 소문자 */
export function normalizeCode(code: string): string {
  return (code || '').toLowerCase().replace(/[-\s]/g, '');
}

/** 어떤 형식이든 표준 단축코드로: PB-A-001 / A-001-01 / A01 → A01 */
export function canonicalShort(raw: string): string {
  const s = (raw || '').trim().toUpperCase().replace(/^PB-/, '');
  const m = s.match(/([A-Z])-?(\d+)/);
  if (!m) return s;
  return `${m[1]}${String(parseInt(m[2], 10)).padStart(2, '0')}`;
}

/** 자연 정렬: F01, F02, F06, F12, F104 ... (알파벳 사전순 X) */
export function compareCode(a: string, b: string): number {
  const ma = (a || '').match(/^([A-Za-z]+)(\d+)/);
  const mb = (b || '').match(/^([A-Za-z]+)(\d+)/);
  if (ma && mb) {
    const letterCmp = ma[1].toUpperCase().localeCompare(mb[1].toUpperCase());
    if (letterCmp !== 0) return letterCmp;
    return parseInt(ma[2], 10) - parseInt(mb[2], 10);
  }
  return (a || '').localeCompare(b || '');
}
