/** ERP 형식(A-001-01, F-528-01)을 단축 형식(A-01, F-528)으로 변환 */
export function convertErpCode(raw: string): string {
  const m = (raw || '').trim().match(/^([A-Za-z])-(\d+)-\d+$/);
  if (!m) return (raw || '').trim();
  const letter = m[1].toUpperCase();
  const num = String(parseInt(m[2], 10)).padStart(2, '0');
  return `${letter}-${num}`;
}

/** 비교용 정규화: 대시·공백 제거 + 소문자 */
export function normalizeCode(code: string): string {
  return (code || '').toLowerCase().replace(/[-\s]/g, '');
}
