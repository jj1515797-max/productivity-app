/** 생산 완료(진행률 100%) 알림 — 기기별 구독
 *
 *  · 상단 '현황' 버튼을 5초 꾹 누르면 이 기기에서 알림을 켜고 끌 수 있다.
 *  · 설정은 localStorage 에 저장되므로 PC·휴대폰 각각 따로 켜야 한다.
 *    (= 확인을 누른 기기에만 알림이 간다)
 *  · 알림은 브라우저가 실행 중일 때만 뜬다. 탭이 뒤에 있어도 되지만
 *    브라우저를 완전히 끄면 못 받는다. (그건 웹푸시가 있어야 함)
 */
import { collection, onSnapshot } from 'firebase/firestore';
import { db } from '../firebase';
import { todayKey } from './dateUtil';

const KEY_ON = 'completionAlert:on';
const KEY_DONE = 'completionAlert:notified';   // 마지막으로 알린 날짜
const MACHINES = ['1호기', '2호기', '3호기'];

export function isAlertOn(): boolean {
  try { return localStorage.getItem(KEY_ON) === '1'; } catch { return false; }
}
function setAlertOn(on: boolean) {
  try {
    if (on) localStorage.setItem(KEY_ON, '1');
    else localStorage.removeItem(KEY_ON);
  } catch { /* 시크릿 모드 등 */ }
}
export function supportsNotification(): boolean {
  return typeof window !== 'undefined' && 'Notification' in window;
}

function lastNotifiedDate(): string {
  try { return localStorage.getItem(KEY_DONE) || ''; } catch { return ''; }
}
function markNotified(date: string) {
  try { localStorage.setItem(KEY_DONE, date); } catch { /* noop */ }
}

/** 짧은 알림음 (파일 없이 WebAudio 로 생성) */
function beep() {
  try {
    const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const play = (freq: number, start: number, dur: number) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, ctx.currentTime + start);
      gain.gain.exponentialRampToValueAtTime(0.25, ctx.currentTime + start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + start + dur);
      osc.connect(gain); gain.connect(ctx.destination);
      osc.start(ctx.currentTime + start);
      osc.stop(ctx.currentTime + start + dur + 0.05);
    };
    play(880, 0, 0.18);
    play(1175, 0.2, 0.28);
    setTimeout(() => ctx.close().catch(() => {}), 1500);
  } catch { /* 자동재생 차단 등 */ }
}

export function fireNotification(title: string, body: string, tag: string) {
  try {
    if (supportsNotification() && Notification.permission === 'granted') {
      const n = new Notification(title, {
        body,
        tag,
        requireInteraction: true,
      });
      n.onclick = () => { window.focus(); n.close(); };
    }
  } catch { /* noop */ }
  try { navigator.vibrate?.([300, 120, 300, 120, 500]); } catch { /* noop */ }
  beep();
}

/** 5초 꾹 누르기로 켜고 끄기. 반환값 = 처리 후 켜짐 여부 */
export async function toggleAlertByLongPress(): Promise<boolean> {
  if (isAlertOn()) {
    if (confirm('이 기기의 생산 완료 알림을 끌까요?')) {
      setAlertOn(false);
      return false;
    }
    return true;
  }

  if (!supportsNotification()) {
    alert('이 브라우저는 알림을 지원하지 않습니다.\n(iPhone 은 Safari 에서 "홈 화면에 추가" 후 사용해 주세요)');
    return false;
  }

  const ok = confirm(
    '이 기기에서 생산 완료 알림을 받겠습니까?\n\n'
    + '· 진행률이 100% 가 되면 알림이 뜹니다 (하루 1회)\n'
    + '· 확인을 누른 이 기기에만 갑니다 (PC·휴대폰 각각 따로 설정)\n'
    + '· 브라우저가 켜져 있어야 합니다 (다른 탭에 있어도 됩니다)',
  );
  if (!ok) return false;

  let perm = Notification.permission;
  if (perm === 'default') {
    try { perm = await Notification.requestPermission(); } catch { perm = 'denied'; }
  }
  if (perm !== 'granted') {
    alert('알림 권한이 거부되어 있습니다.\n브라우저 주소창 옆 자물쇠(ⓘ) → 알림 → 허용 으로 바꿔주세요.');
    return false;
  }

  setAlertOn(true);
  fireNotification('알림이 켜졌습니다', '오늘 생산이 100% 완료되면 이 기기로 알려드립니다.', 'ssbon-alert-test');
  return true;
}

export interface DailyProgress {
  date: string;
  itemCount: number;
  completedItems: number;
  totalQty: number;
  pct: number;
}

/** 오늘 진행률을 구독. 알림이 켜진 기기에서만 호출된다. */
export function watchTodayProgress(onChange: (p: DailyProgress) => void): () => void {
  const date = todayKey();
  let items: { code: string; totalQty: number }[] = [];
  const machineQty: Record<string, Record<string, number>> = {};
  let logistics: Record<string, number> = {};
  let hasLogistics = false;

  const emit = () => {
    const actualByCode: Record<string, number> = {};
    Object.values(machineQty).forEach((m) => {
      Object.entries(m).forEach(([code, q]) => { actualByCode[code] = (actualByCode[code] || 0) + q; });
    });
    const totalQty = items.reduce((s, i) => s + (i.totalQty || 0), 0);
    // Dashboard 와 동일 규칙
    const completedItems = items.filter((i) => {
      const norm = i.code.toLowerCase().replace(/[-\s]/g, '');
      if (logistics[norm] !== undefined) return true;
      return (actualByCode[i.code.toLowerCase()] || 0) >= i.totalQty && i.totalQty > 0;
    }).length;
    const pct = totalQty
      ? Math.round((items.reduce((s, i) => {
        const produced = actualByCode[i.code.toLowerCase()] || 0;
        return s + Math.min(produced, i.totalQty || 0);
      }, 0) / totalQty) * 100)
      : 0;
    onChange({
      date,
      itemCount: items.length,
      completedItems,
      totalQty,
      pct: hasLogistics ? 100 : pct,
    });
  };

  const unsubs: (() => void)[] = [];
  unsubs.push(onSnapshot(collection(db, 'days', date, 'items'), (snap) => {
    items = snap.docs.map((d) => {
      const v = d.data() as { code?: string; totalQty?: number };
      return { code: String(v.code || ''), totalQty: v.totalQty || 0 };
    }).filter((x) => x.code);
    emit();
  }, () => {}));

  MACHINES.forEach((m) => {
    unsubs.push(onSnapshot(collection(db, 'days', date, 'machines', m, 'entries'), (snap) => {
      const q: Record<string, number> = {};
      snap.forEach((d) => {
        const e = d.data() as { code?: string; actualProduction?: number; additionalProduction?: number };
        const k = String(e.code || '').toLowerCase();
        if (!k) return;
        q[k] = (q[k] || 0) + (e.actualProduction || 0) + (e.additionalProduction || 0);
      });
      machineQty[m] = q;
      emit();
    }, () => {}));
  });

  unsubs.push(onSnapshot(collection(db, 'days', date, 'logistics'), (snap) => {
    const map: Record<string, number> = {};
    snap.forEach((d) => { map[(d.id || '').toLowerCase().replace(/[-\s]/g, '')] = (d.data().qty as number) || 0; });
    logistics = map;
    hasLogistics = Object.keys(map).length > 0;
    emit();
  }, () => {}));

  return () => unsubs.forEach((u) => u());
}

/** 진행률 100% 를 감지해 하루 한 번 알림 발사 */
export function handleProgress(p: DailyProgress) {
  if (p.itemCount <= 0 || p.totalQty <= 0) return;
  if (p.pct < 100) return;
  if (lastNotifiedDate() === p.date) return;
  markNotified(p.date);
  fireNotification(
    '✅ 생산 완료',
    `${p.date} 전 품목 생산이 완료되었습니다 (${p.completedItems}/${p.itemCount}품목 · ${p.totalQty.toLocaleString()}EA)`,
    `ssbon-done-${p.date}`,
  );
}
