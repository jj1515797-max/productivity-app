/** 냉각 입출고 — 대차 단위 냉각실 입고·타이머·출고
 *
 *  Firestore
 *   - coolingCarts/{자동ID}  대차 1대 = 1건 (채널 1개 고정, 품목 여러 개)
 *       { date, cartNo, room, slot, channel, items[{code,name,qty}], startAt, endAt, durationMin, out, outAt? }
 *     진행 중 조회는 out == false 로 한다 (자정·새벽 2시를 넘겨도 냉각실에 있는 건 계속 보여야 함)
 *   - coolingConfig/main     냉각실 도면(줄×칸)과 단계별 냉각 시간
 */
import { useEffect, useState } from 'react';
import { doc, onSnapshot, setDoc } from 'firebase/firestore';
import { db } from '../firebase';

export const CART_COL = 'coolingCarts';
export const CONFIG_DOC = doc(db, 'coolingConfig', 'main');

export type Channel = '주문' | '쿠팡' | '마켓컬리' | '오아시스' | '샘플';
export const CHANNELS: Channel[] = ['주문', '쿠팡', '마켓컬리', '오아시스', '샘플'];

/** 현황판 열 색과 같게 — 대차에 붙은 채널 스티커와 화면 색을 맞춘다 */
export const CH_STYLE: Record<Channel, { bg: string; soft: string; text: string; border: string; dot: string }> = {
  주문: { bg: 'bg-slate-600', soft: 'bg-slate-50', text: 'text-slate-700', border: 'border-slate-400', dot: 'bg-slate-500' },
  쿠팡: { bg: 'bg-orange-500', soft: 'bg-orange-50', text: 'text-orange-700', border: 'border-orange-400', dot: 'bg-orange-500' },
  마켓컬리: { bg: 'bg-blue-600', soft: 'bg-blue-50', text: 'text-blue-700', border: 'border-blue-400', dot: 'bg-blue-600' },
  오아시스: { bg: 'bg-emerald-600', soft: 'bg-emerald-50', text: 'text-emerald-700', border: 'border-emerald-400', dot: 'bg-emerald-600' },
  샘플: { bg: 'bg-amber-500', soft: 'bg-amber-50', text: 'text-amber-700', border: 'border-amber-400', dot: 'bg-amber-500' },
};

/** 도면 칸처럼 좁은 곳에 쓰는 짧은 이름 */
export const CH_SHORT: Record<Channel, string> = { 주문: '주문', 쿠팡: '쿠팡', 마켓컬리: '컬리', 오아시스: '오아시스', 샘플: '샘플' };

export interface CartItem { code: string; name: string; qty: number }
export interface CoolingCart {
  id: string;
  date: string;
  cartNo: string;
  room: number;
  slot: number;            // -1 = 자리 미지정 (냉각실이 꽉 찼을 때)
  channel: Channel;
  items: CartItem[];
  startAt: number;
  endAt: number;
  durationMin: number;
  out: boolean;
  outAt?: number;
}

export interface RoomConfig { id: number; name: string; rows: number; cols: number }
export interface CoolingConfig {
  rooms: RoomConfig[];
  /** 품목코드 첫 글자(단계) → 냉각 분. 없는 글자는 defaultMin */
  durations: Record<string, number>;
  defaultMin: number;
}

export const DEFAULT_CONFIG: CoolingConfig = {
  rooms: [
    { id: 1, name: '냉각실 1', rows: 4, cols: 8 },
    { id: 2, name: '냉각실 2', rows: 4, cols: 8 },
    { id: 3, name: '냉각실 3', rows: 4, cols: 8 },
  ],
  durations: { A: 40, B: 40, F: 40, C: 50, D: 50, E: 50, G: 50, H: 50, I: 50 },
  defaultMin: 50,
};

export function useCoolingConfig(): [CoolingConfig, (c: CoolingConfig) => Promise<void>] {
  const [cfg, setCfg] = useState<CoolingConfig>(DEFAULT_CONFIG);
  useEffect(() => onSnapshot(CONFIG_DOC, (s) => {
    if (!s.exists()) return;
    const d = s.data() as Partial<CoolingConfig>;
    setCfg({
      rooms: d.rooms?.length ? d.rooms : DEFAULT_CONFIG.rooms,
      durations: { ...DEFAULT_CONFIG.durations, ...(d.durations || {}) },
      defaultMin: d.defaultMin || DEFAULT_CONFIG.defaultMin,
    });
  }), []);
  const save = async (c: CoolingConfig) => { await setDoc(CONFIG_DOC, c); };
  return [cfg, save];
}

/** 품목코드 → 단계 글자 (F553 → F, H-002 → H) */
export const stageOf = (code: string) => (code.trim()[0] || '').toUpperCase();
export const minutesFor = (cfg: CoolingConfig, code: string) => cfg.durations[stageOf(code)] ?? cfg.defaultMin;
/** 대차에 여러 품목이 섞이면 가장 오래 걸리는 품목 기준으로 끝난다 */
export const cartMinutes = (cfg: CoolingConfig, codes: string[]) =>
  Math.max(...codes.map((c) => minutesFor(cfg, c)), 1);

/** 채우는 순서 — 맨 오른쪽 줄을 안쪽(위)부터 입구(아래)까지 채우고, 그다음 왼쪽 줄로 */
export function fillOrder(room: RoomConfig): number[] {
  const out: number[] = [];
  for (let c = room.cols - 1; c >= 0; c--) for (let r = 0; r < room.rows; r++) out.push(r * room.cols + c);
  return out;
}
export function nextFreeSlot(room: RoomConfig, carts: CoolingCart[]): number {
  const used = new Set(carts.filter((c) => !c.out && c.room === room.id).map((c) => c.slot));
  return fillOrder(room).find((s) => !used.has(s)) ?? -1;
}
/** 화면에 보이는 자리 이름 — 오른쪽부터 1줄, 줄 안에서는 안쪽부터 1번째 */
export function slotLabel(room: RoomConfig, slot: number): string {
  if (slot < 0) return '자리 미지정';
  const r = Math.floor(slot / room.cols);
  const c = slot % room.cols;
  return `오른쪽 ${room.cols - c}줄 · 안쪽부터 ${r + 1}번째`;
}

/** 보고 있는 날짜의 대차만 정상 표시, 나머지는 '다른 날' 로 흐리게.
 *  생산 당일을 볼 때는 전날 넣고 아직 안 뺀 대차도 실제로 냉각실에 있으니 같이 보여 준다. */
export function splitByDate(carts: CoolingCart[], date: string, today: string) {
  const mine = (c: CoolingCart) => c.date === date || (date === today && c.date < today);
  return { shown: carts.filter(mine), ghosts: carts.filter((c) => !mine(c)) };
}

export function fmtLeft(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(s / 60);
  const ss = s % 60;
  return `${m}:${String(ss).padStart(2, '0')}`;
}
export function hhmm(t: number): string {
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/* ---------- 알림음 ---------- */
let ctx: AudioContext | null = null;
export function chime(kind: 'done' | 'tap' = 'done') {
  try {
    if (!ctx) ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
    const a = ctx!;
    if (a.state === 'suspended') a.resume();
    const tone = (f: number, t: number, d: number) => {
      const o = a.createOscillator(); const g = a.createGain();
      o.frequency.value = f; o.type = 'sine';
      g.gain.setValueAtTime(0.0001, a.currentTime + t);
      g.gain.exponentialRampToValueAtTime(0.4, a.currentTime + t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, a.currentTime + t + d);
      o.connect(g).connect(a.destination); o.start(a.currentTime + t); o.stop(a.currentTime + t + d + 0.05);
    };
    if (kind === 'tap') tone(1200, 0, 0.08);
    else { tone(880, 0, 0.25); tone(1175, 0.3, 0.25); tone(1568, 0.6, 0.4); }
  } catch { /* 무시 */ }
}
