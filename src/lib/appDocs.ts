/** collectionGroup 결과에서 '날짜별 생산 문서(days/…)'만 고르는 필터.
 *
 *  collectionGroup('items') 는 이름이 같은 다른 하위 컬렉션도 같이 잡는다.
 *    · days/{날짜}/items         — 생산계획 품목 (우리가 원하는 것)
 *    · remix/{날짜}/items        — 재배합 기록 {code, qty, count, date} ← date 가 있어 날짜 범위 조회에 섞인다
 *  collectionGroup('entries') 도 마찬가지:
 *    · days/{날짜}/machines/{호기}/entries — 호기별 생산
 *    · waste/{날짜}/entries                — 폐기 기록
 *  그래서 경로로 거른다 (containerLoad 에서 쓰던 규칙을 공용으로 뺀 것).
 */
import { collection, getDocs, limit, query } from 'firebase/firestore';
import { db } from '../firebase';

type Snap = { ref: { path: string }; data: () => unknown };

/** days/{날짜}/… 아래 문서 (생산계획 items · 외포장 ambient) */
export const isDaysDoc = (d: Snap) => d.ref.path.startsWith('days/');

/** days/{날짜}/machines/{호기}/entries 의 호기 생산 기록 (호기 없는 유령 문서 제외) */
export const isMachineEntryDoc = (d: Snap) =>
  isDaysDoc(d) && d.ref.path.includes('/machines/') && !!(d.data() as { machine?: string } | undefined)?.machine;

/** waste/{날짜}/entries 의 폐기 기록 */
export const isWasteEntryDoc = (d: Snap) => d.ref.path.startsWith('waste/');

/** 그 달에 생산계획(days/{날짜}/items)이 하루라도 있나 — 날짜마다 1건만 본다 (최대 31읽기).
 *  collectionGroup + limit(1) 은 재배합 문서가 먼저 나와 틀릴 수 있어 날짜별로 직접 본다. */
export async function monthHasDayItems(month: string): Promise<boolean> {
  const [y, m] = month.split('-').map(Number);
  const last = new Date(y, m, 0).getDate();
  const dates = Array.from({ length: last }, (_, i) => `${month}-${String(i + 1).padStart(2, '0')}`);
  const snaps = await Promise.all(dates.map((d) => getDocs(query(collection(db, 'days', d, 'items'), limit(1))).catch(() => null)));
  return snaps.some((s) => s && !s.empty);
}
