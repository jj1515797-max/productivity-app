/** 냉각 화면 공용 구독 — 진행 중 대차, 오늘 입고 기록, 오늘 품목·생산량 */
import { useEffect, useMemo, useState } from 'react';
import { collection, onSnapshot, query, where } from 'firebase/firestore';
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

export interface PendingCard {
  key: string;             // code|channel
  code: string;
  name: string;
  channel: Channel;
  planQty: number;         // 그 채널 몫 (주문은 잔여 포함)
  inQty: number;           // 이미 대차에 실어 입고한 수량
  remain: number;
  produced: number;        // 내포장(호기) 입력 합계
  target: number;          // 총수량
  lastAt: string;          // 외포장 분류 완료 시각 HH:MM (가장 최근)
  packs: number[];         // 분류 완료한 외포장 번호 (1·2·3)
}

/** 외포장(1·2·3)에서 「분류 완료」 한 품목만 → 품목×채널 카드.
 *  잔여(생산 − 총수량, 물류 잔여량 입력이 있으면 그 값)는 주문 몫에 더한다. */
export function usePendingCards(date: string, dayCarts: CoolingCart[], sorted: PackSorted[]): { cards: PendingCard[]; loaded: boolean } {
  const [items, setItems] = useState<Item[] | null>(null);
  const [qty, setQty] = useState<Record<string, Record<string, number>>>({});
  const [logi, setLogi] = useState<Record<string, number>>({});

  useEffect(() => { setItems(null); return onSnapshot(collection(db, 'days', date, 'items'), (s) => {
    const a: Item[] = []; s.forEach((d) => a.push(d.data() as Item)); setItems(a);
  }); }, [date]);
  useEffect(() => {
    setQty({});
    const unsubs = (['1호기', '2호기', '3호기'] as const).map((m) =>
      onSnapshot(collection(db, 'days', date, 'machines', m, 'entries'), (s) => {
        const map: Record<string, number> = {};
        s.forEach((d) => {
          const e = d.data() as MachineEntry;
          const k = String(e.code || '').toLowerCase();
          map[k] = (map[k] || 0) + (e.actualProduction || 0) + (e.additionalProduction || 0);
        });
        setQty((p) => ({ ...p, [m]: map }));
      }));
    return () => unsubs.forEach((u) => u());
  }, [date]);
  useEffect(() => { setLogi({}); return onSnapshot(collection(db, 'days', date, 'logistics'), (s) => {
    const map: Record<string, number> = {};
    s.forEach((d) => { map[(d.id || '').toLowerCase().replace(/[-\s]/g, '')] = (d.data().qty as number) || 0; });
    setLogi(map);
  }); }, [date]);

  const cards = useMemo(() => {
    if (!items) return [];
    const produced: Record<string, number> = {};
    Object.values(qty).forEach((m) => Object.entries(m).forEach(([k, v]) => { produced[k] = (produced[k] || 0) + v; }));
    const inQty: Record<string, number> = {};
    dayCarts.forEach((c) => c.items.forEach((i) => {
      const k = `${i.code.toLowerCase()}|${c.channel}`;
      inQty[k] = (inQty[k] || 0) + (i.qty || 0);
    }));
    // 품목코드 → 분류 완료한 외포장 번호·가장 최근 시각
    const sortedBy: Record<string, { packs: Set<number>; at: number }> = {};
    sorted.forEach((x) => {
      const k = String(x.code || '').toLowerCase();
      const e = sortedBy[k] || (sortedBy[k] = { packs: new Set(), at: 0 });
      e.packs.add(x.pack);
      if (x.at > e.at) e.at = x.at;
    });
    const hm = (t: number) => { const d = new Date(t); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
    const out: PendingCard[] = [];
    items.forEach((it) => {
      const sb = sortedBy[it.code.toLowerCase()];
      if (!sb) return;                         // 외포장에서 분류 완료 안 한 품목은 안 띄운다
      const p = produced[it.code.toLowerCase()] || 0;
      const norm = it.code.toLowerCase().replace(/[-\s]/g, '');
      const extra = logi[norm] !== undefined ? logi[norm] : Math.max(0, p - (it.totalQty || 0));
      const plan: [Channel, number][] = [
        ['주문', (it.orderQty || 0) + Math.max(0, extra)],
        ['쿠팡', it.coupang || 0],
        ['마켓컬리', it.marketKurly || 0],
        ['오아시스', it.oasis || 0],
        ['샘플', it.sample || 0],
      ];
      plan.forEach(([ch, q]) => {
        if (q <= 0) return;
        const k = `${it.code.toLowerCase()}|${ch}`;
        const done = inQty[k] || 0;
        if (done >= q) return;
        out.push({ key: `${it.code}|${ch}`, code: it.code, name: it.name, channel: ch, planQty: q, inQty: done, remain: q - done, produced: p, target: it.totalQty || 0, lastAt: hm(sb.at), packs: [...sb.packs].sort() });
      });
    });
    // 방금 분류된 품목이 위로 — 같은 시각이면 코드·채널 순
    const chOrder = ['주문', '쿠팡', '마켓컬리', '오아시스', '샘플'];
    out.sort((a, b) => b.lastAt.localeCompare(a.lastAt) || a.code.localeCompare(b.code) || chOrder.indexOf(a.channel) - chOrder.indexOf(b.channel));
    return out;
  }, [items, qty, logi, dayCarts, sorted]);

  return { cards, loaded: items !== null };
}
