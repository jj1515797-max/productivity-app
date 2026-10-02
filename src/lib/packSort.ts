/** 외포장 분류 완료 — 외포장-1/2/3 화면에서 품목 행을 누르면 기록된다.
 *  Firestore `days/{날짜}/packSorted/{호기번호}_{entry문서ID}` = { pack, machine, entryId, code, at }
 *  호기 입력(entries) 문서는 건드리지 않고 따로 둔다. 외포장 입력(냉각 입고 대기)은 이 기록이 있는 품목만 띄운다. */
import { useEffect, useState } from 'react';
import { collection, deleteDoc, doc, onSnapshot, setDoc } from 'firebase/firestore';
import { db } from '../firebase';

export interface PackSorted { id: string; pack: number; machine: string; entryId: string; code: string; at: number }

export const sortedDocId = (pack: number, entryId: string) => `${pack}_${entryId}`;

export function useSorted(date: string): PackSorted[] {
  const [list, setList] = useState<PackSorted[]>([]);
  useEffect(() => {
    setList([]);
    return onSnapshot(collection(db, 'days', date, 'packSorted'), (s) => {
      const a: PackSorted[] = [];
      s.forEach((d) => a.push({ ...(d.data() as PackSorted), id: d.id }));
      setList(a);
    });
  }, [date]);
  return list;
}

export function markSorted(date: string, pack: number, entryId: string, code: string) {
  return setDoc(doc(db, 'days', date, 'packSorted', sortedDocId(pack, entryId)),
    { pack, machine: `${pack}호기`, entryId, code, at: Date.now() });
}
export function unmarkSorted(date: string, pack: number, entryId: string) {
  return deleteDoc(doc(db, 'days', date, 'packSorted', sortedDocId(pack, entryId)));
}
