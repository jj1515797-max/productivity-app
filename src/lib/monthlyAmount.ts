/** 월 생산금액(원) — monthlyMeta/{YYYY-MM}.productionAmount
 *  서버에 저장해서 어느 기기(PC·휴대폰)에서 열어도 같은 값이 보인다.
 *  예전에는 원재료분석 「원가율로 보기」 값을 그 브라우저(localStorage)에만 두었다 —
 *  그 기기에 남아 있던 값은 서버가 비어 있을 때 한 번 올린다. */
import { useEffect, useState } from 'react';
import { doc, onSnapshot, setDoc } from 'firebase/firestore';
import { db } from '../firebase';

const COL = 'monthlyMeta';
const LEGACY_KEYS = (m: string) => [`matDecompAmt:${m}`, `matAnalysis:amt:${m}`];

const readLegacy = (m: string): number => {
  try {
    for (const k of LEGACY_KEYS(m)) { const v = Number(localStorage.getItem(k)); if (v > 0) return v; }
  } catch { /* noop */ }
  return 0;
};
const clearLegacy = (m: string) => { try { LEGACY_KEYS(m).forEach((k) => localStorage.removeItem(k)); } catch { /* noop */ } };

export function saveProductionAmount(month: string, v: number) {
  clearLegacy(month);   // 지운(0) 값을 옛 브라우저 값이 다시 덮지 않게
  return setDoc(doc(db, COL, month), { productionAmount: v > 0 ? Math.round(v) : 0, updatedAt: new Date().toISOString() }, { merge: true });
}

/** 여러 달 생산금액을 실시간으로 — 다른 기기에서 고쳐도 바로 반영 */
export function useProductionAmounts(months: string[]): Record<string, number> {
  const [map, setMap] = useState<Record<string, number>>({});
  const key = [...new Set(months.filter(Boolean))].sort().join(',');
  useEffect(() => {
    const list = key ? key.split(',') : [];
    const unsubs = list.map((m) => onSnapshot(doc(db, COL, m), (s) => {
      const v = Number((s.data() as { productionAmount?: number } | undefined)?.productionAmount) || 0;
      if (v <= 0) {
        const legacy = readLegacy(m);
        if (legacy > 0) { saveProductionAmount(m, legacy).catch(() => {}); return; }   // 다음 스냅샷에서 반영
      }
      setMap((p) => (p[m] === v ? p : { ...p, [m]: v }));
    }, () => {}));
    return () => unsubs.forEach((u) => u());
  }, [key]);
  return map;
}
