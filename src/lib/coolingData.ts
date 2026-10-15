/** 냉각 화면 공용 구독 — 진행 중 대차, 오늘 입고 기록, 오늘 품목·생산량 */
import { useEffect, useMemo, useState } from 'react';
import { collection, deleteDoc, doc, onSnapshot, query, setDoc, updateDoc, where } from 'firebase/firestore';
import { db } from '../firebase';
import type { Item, MachineEntry } from '../types';
import { CART_COL } from './cooling';
import type { Channel, CoolingCart } from './cooling';
import type { PackSorted } from './packSort';

/** 냉각실에 있는(출고 안 된) 대차 — 날짜와 무관 */
export function useActiveCarts(): CoolingCart[] {
  const [list, setList] = useState<CoolingCart[]>([]);
  useEffect(() => onSnapshot(query(collection(db, CART_COL), where('out', '==', false)), (s) => {
    const a: CoolingCart[] = [];
    s.forEach((d) => a.push({ ...(d.data() as CoolingCart), id: d.id }));
    a.sort((x, y) => x.endAt - y.endAt);
    setList(a);
  }), []);
  return list;
}

/** 그 날짜에 입고한 대차 전부 (출고된 것 포함) — 품목·채널별로 얼마나 넣었는지 계산용 */
export function useDayCarts(date: string): CoolingCart[] {
  const [list, setList] = useState<CoolingCart[]>([]);
  useEffect(() => onSnapshot(query(collection(db, CART_COL), where('date', '==', date)), (s) => {
    const a: CoolingCart[] = [];
    s.forEach((d) => a.push({ ...(d.data() as CoolingCart), id: d.id }));
    setList(a);
  }), [date]);
  return list;
}

/** 입고 대기 카드 종류
 *  · plan  — 생산계획 채널 몫 (품목×채널, 지금까지의 카드)
 *  · add   — 내포장 「추가 생산」 입력 한 줄을 외포장에서 분류 완료한 것. 채널은 현장에서 고른다
 *  · split — 카드 하나를 둘로 나눠 떼어 낸 몫. 채널은 현장에서 고른다 */
export type CardKind = 'plan' | 'add' | 'split';

export interface PendingCard {
  key: string;             // plan: 코드|채널 · add: add:외포장번호:입력ID · split: split:문서ID  (대차 품목 src 와 같은 값)
  kind: CardKind;
  docId?: string;          // add·split — days/{날짜}/coolCards 문서 ID
  code: string;
  name: string;
  channel: Channel | null; // add·split 은 채널을 고르기 전까지 null (그동안은 대차에 못 싣는다)
  planQty: number;         // 이 카드의 원래 몫 (plan: 채널 몫·주문은 잔여 포함 / add: 추가 생산량 / split: 나눈 수량)
  inQty: number;           // 이미 대차에 실어 입고한 수량
  splitOut: number;        // 이 카드에서 나눠 떼어 낸 수량
  remain: number;
  produced: number;        // 내포장(호기) 입력 합계 (추가 생산 포함)
  target: number;          // 총수량
  lastAt: string;          // 외포장 분류 완료 시각 HH:MM (가장 최근)
  packs: number[];         // 분류 완료한 외포장 번호 (1·2·3)
  at: number;              // 정렬용 — 분류 완료(추가 생산) · 나눈 시각
}

/** days/{날짜}/coolCards — 추가 생산 카드의 채널, 나눈 카드 */
export const COOL_CARDS = 'coolCards';
export interface CoolCardDoc {
  kind: 'add' | 'split';
  channel: Channel | null;
  at: number;
  // split 만
  from?: string;           // 떼어 낸 카드 key
  code?: string;
  name?: string;
  qty?: number;
  packs?: number[];
}
export const addCardDocId = (pack: number, entryId: string) => `add_${pack}_${entryId}`;

/** 추가 생산·나눈 카드의 채널 정하기 (여러 장 한 번에) */
export function setCardsChannel(date: string, cards: PendingCard[], ch: Channel) {
  return Promise.all(cards.filter((c) => c.kind !== 'plan' && c.docId).map((c) => (c.kind === 'add'
    ? setDoc(doc(db, 'days', date, COOL_CARDS, c.docId!), { kind: 'add', channel: ch, at: Date.now() }, { merge: true })
    : updateDoc(doc(db, 'days', date, COOL_CARDS, c.docId!), { channel: ch }))));
}

/** 카드를 둘로 나눈다 — 남은 수량의 절반(내림)을 새 카드로 떼어 낸다. 새 카드는 채널 미지정. 새 카드 key 를 돌려준다 */
export function splitCard(date: string, c: PendingCard): { key: string; qty: number; done: Promise<void>; undo: () => Promise<void> } {
  const qty = Math.floor(c.remain / 2);
  const ref = doc(collection(db, 'days', date, COOL_CARDS));
  const data: CoolCardDoc = { kind: 'split', channel: null, from: c.key, code: c.code, name: c.name, qty, packs: c.packs, at: Date.now() };
  return { key: `split:${ref.id}`, qty, done: setDoc(ref, data), undo: () => deleteDoc(ref) };
}

/** 나눈 카드를 원래 카드로 되돌린다 (아직 싣지도, 다시 나누지도 않은 것만) */
export function unsplitCard(date: string, c: PendingCard) {
  return deleteDoc(doc(db, 'days', date, COOL_CARDS, c.docId!));
}

interface EntryLite { code: string; actual: number; add: number }

/** 외포장(1·2·3)에서 「분류 완료」 한 것만 → 입고 대기 카드.
 *  · 생산계획 카드: 품목×채널. 잔여(실제 생산 − 총수량, 물류 잔여량 입력이 있으면 그 값)는 주문 몫에 더한다.
 *    추가 생산은 따로 카드가 되므로 잔여 계산에서 뺀다.
 *  · 추가 생산 카드: 추가 생산 입력 한 줄마다 하나 (그 줄을 외포장에서 분류 완료해야 뜬다).
 *  · 나눈 카드: coolCards 의 split 문서.
 *  남은 수량 = 원래 몫 − 그 카드에서 실은 수량 − 그 카드에서 나눠 떼어 낸 수량.
 *  대차 품목에 src(카드 key)가 있으면 그 카드로, 없으면(예전 대차) 품목코드|대차채널 의 생산계획 카드로 센다. */
export function usePendingCards(date: string, dayCarts: CoolingCart[], sorted: PackSorted[]): { cards: PendingCard[]; loaded: boolean } {
  const [items, setItems] = useState<Item[] | null>(null);
  // 호기별 살아 있는 입력 — 내포장에서 지운 입력의 분류 완료 기록은 무시하고, 추가 생산 줄은 따로 카드로
  const [ents, setEnts] = useState<Record<string, Record<string, EntryLite>>>({});
  const [logi, setLogi] = useState<Record<string, number>>({});
  const [coolDocs, setCoolDocs] = useState<Record<string, CoolCardDoc>>({});

  useEffect(() => { setItems(null); return onSnapshot(collection(db, 'days', date, 'items'), (s) => {
    const a: Item[] = []; s.forEach((d) => a.push(d.data() as Item)); setItems(a);
  }); }, [date]);
  useEffect(() => {
    setEnts({});
    const unsubs = (['1호기', '2호기', '3호기'] as const).map((m) =>
      onSnapshot(collection(db, 'days', date, 'machines', m, 'entries'), (s) => {
        const map: Record<string, EntryLite> = {};
        s.forEach((d) => {
          const e = d.data() as MachineEntry;
          map[d.id] = { code: String(e.code || ''), actual: e.actualProduction || 0, add: e.additionalProduction || 0 };
        });
        setEnts((p) => ({ ...p, [m]: map }));
      }));
    return () => unsubs.forEach((u) => u());
  }, [date]);
  useEffect(() => { setLogi({}); return onSnapshot(collection(db, 'days', date, 'logistics'), (s) => {
    const map: Record<string, number> = {};
    s.forEach((d) => { map[(d.id || '').toLowerCase().replace(/[-\s]/g, '')] = (d.data().qty as number) || 0; });
    setLogi(map);
  }); }, [date]);
  useEffect(() => { setCoolDocs({}); return onSnapshot(collection(db, 'days', date, COOL_CARDS), (s) => {
    const map: Record<string, CoolCardDoc> = {};
    s.forEach((d) => { map[d.id] = d.data() as CoolCardDoc; });
    setCoolDocs(map);
  }, () => {}); }, [date]);

  const cards = useMemo(() => {
    if (!items) return [];
    const produced: Record<string, number> = {};   // 추가 생산 포함 (표시용)
    const actualOnly: Record<string, number> = {}; // 추가 생산 뺀 것 (잔여 계산용)
    Object.values(ents).forEach((m) => Object.values(m).forEach((e) => {
      const k = e.code.toLowerCase();
      produced[k] = (produced[k] || 0) + e.actual + e.add;
      actualOnly[k] = (actualOnly[k] || 0) + e.actual;
    }));
    const inQty: Record<string, number> = {};
    dayCarts.forEach((c) => c.items.forEach((i) => {
      const k = i.src || `${i.code}|${c.channel}`;
      inQty[k] = (inQty[k] || 0) + (i.qty || 0);
    }));
    const splitOut: Record<string, number> = {};
    Object.values(coolDocs).forEach((d) => { if (d.kind === 'split' && d.from) splitOut[d.from] = (splitOut[d.from] || 0) + (d.qty || 0); });
    const itemOf = new Map(items.map((it) => [it.code.toLowerCase(), it]));
    const hm = (t: number) => { const d = new Date(t); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
    const out: PendingCard[] = [];
    const push = (c: Omit<PendingCard, 'inQty' | 'splitOut' | 'remain'>) => {
      const done = inQty[c.key] || 0;
      const so = splitOut[c.key] || 0;
      const remain = c.planQty - done - so;
      if (remain > 0) out.push({ ...c, inQty: done, splitOut: so, remain });
    };

    // 품목코드 → 분류 완료한 외포장 번호·가장 최근 시각 (생산계획 카드용 — 추가 생산만 있는 줄은 뺀다)
    const sortedBy: Record<string, { packs: Set<number>; at: number }> = {};
    sorted.forEach((x) => {
      // 그 호기 입력이 지워졌으면(내포장에서 삭제) 분류 완료 기록도 없는 것으로 본다
      const e = ents[`${x.pack}호기`]?.[x.entryId];
      if (!e) return;
      const code = x.code || e.code;
      const k = code.toLowerCase();
      if (e.actual > 0 || e.add <= 0) {
        const r = sortedBy[k] || (sortedBy[k] = { packs: new Set(), at: 0 });
        r.packs.add(x.pack);
        if (x.at > r.at) r.at = x.at;
      }
      // 추가 생산 줄 → 그 줄 하나가 카드 하나
      if (e.add > 0) {
        const it = itemOf.get(k);
        const docId = addCardDocId(x.pack, x.entryId);
        push({
          key: `add:${x.pack}:${x.entryId}`, kind: 'add', docId, code: it?.code || code, name: it?.name || '',
          channel: coolDocs[docId]?.channel ?? null, planQty: e.add,
          produced: produced[k] || 0, target: it?.totalQty || 0, lastAt: hm(x.at), packs: [x.pack], at: x.at,
        });
      }
    });
    items.forEach((it) => {
      const sb = sortedBy[it.code.toLowerCase()];
      if (!sb) return;                         // 외포장에서 분류 완료 안 한 품목은 안 띄운다
      const k = it.code.toLowerCase();
      const norm = k.replace(/[-\s]/g, '');
      const extra = logi[norm] !== undefined ? logi[norm] : Math.max(0, (actualOnly[k] || 0) - (it.totalQty || 0));
      const plan: [Channel, number][] = [
        ['주문', (it.orderQty || 0) + Math.max(0, extra)],
        ['쿠팡', it.coupang || 0],
        ['마켓컬리', it.marketKurly || 0],
        ['오아시스', it.oasis || 0],
        ['샘플', it.sample || 0],
      ];
      plan.forEach(([ch, q]) => {
        if (q <= 0) return;
        push({ key: `${it.code}|${ch}`, kind: 'plan', code: it.code, name: it.name, channel: ch, planQty: q,
          produced: produced[k] || 0, target: it.totalQty || 0, lastAt: hm(sb.at), packs: [...sb.packs].sort(), at: 0 });
      });
    });
    // 나눈 카드
    Object.entries(coolDocs).forEach(([id, d]) => {
      if (d.kind !== 'split' || !d.code) return;
      const k = d.code.toLowerCase();
      const it = itemOf.get(k);
      push({ key: `split:${id}`, kind: 'split', docId: id, code: d.code, name: d.name || it?.name || '',
        channel: d.channel ?? null, planQty: d.qty || 0,
        produced: produced[k] || 0, target: it?.totalQty || 0, lastAt: hm(d.at), packs: d.packs || [], at: d.at });
    });
    // 찾기 쉽게 품목코드 순 — 1순위 숫자(02 → 05 → 06 …, 알파벳과 무관), 2순위 알파벳(E02 → F02).
    // 같은 품목이면 생산계획 카드(채널 순) → 추가 생산·나눈 카드(시각 순)
    const chOrder = ['주문', '쿠팡', '마켓컬리', '오아시스', '샘플'];
    const kindOrder = { plan: 0, add: 1, split: 1 };
    const numOf = (c: string) => { const m = c.match(/\d+/); return m ? parseInt(m[0], 10) : Number.MAX_SAFE_INTEGER; };
    const letOf = (c: string) => (c.match(/[A-Za-z]+/)?.[0] || '').toUpperCase();
    out.sort((a, b) => numOf(a.code) - numOf(b.code) || letOf(a.code).localeCompare(letOf(b.code))
      || a.code.localeCompare(b.code) || kindOrder[a.kind] - kindOrder[b.kind] || a.at - b.at
      || chOrder.indexOf(a.channel || '') - chOrder.indexOf(b.channel || ''));
    return out;
  }, [items, ents, logi, dayCarts, sorted, coolDocs]);

  return { cards, loaded: items !== null };
}
