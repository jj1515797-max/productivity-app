/** 내포장 죽 카운팅 (자리 태블릿) + 현황판
 *  - 작업자가 자리에서 품목 선택 → +20/낱개 버튼으로 카운팅
 *  - 같은 품목을 여러 명이 동시에 풀면 풀(pool)에 합산. 실시간 공유.
 *  - 데이터: days/{date}/scoop/{auto}  =  { code, name, worker, qty, ts }
 *  - 작업자 이름은 기기별 localStorage 에 저장 (그날만 — 새벽 2시에 날이 바뀌면 새로 입력)
 *  - 자리 태블릿은 날짜 고정(오늘). 현황판만 날짜를 고를 수 있다
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { addDoc, collection, deleteDoc, doc, getDocs, onSnapshot, setDoc } from 'firebase/firestore';
import { db } from '../firebase';
import type { Item, Member, ProductSetting } from '../types';
import { todayKey, effectiveTodayKey } from '../lib/dateUtil';
import { getStage, STAGE_LETTERS } from '../lib/monthlyProduction';
import { canonicalShort } from '../lib/codeUtil';

interface ScoopEvent {
  id: string;
  code: string;
  name: string;
  worker: string;
  qty: number;
  ts: number;
}
const WORKER_KEY = 'scoop:worker';
const PICKED_KEY = 'scoop:picked';   // 마지막 선택 품목코드 (기기 새로고침해도 유지)
const WORKER_DAY_KEY = 'scoop:workerDay';   // 이름을 넣은 생산일 — 날이 바뀌면 이름을 새로 받는다

export default function Scoop({ board }: { board?: boolean }) {
  const [date, setDate] = useState(effectiveTodayKey());
  const [items, setItems] = useState<Item[]>([]);
  const [events, setEvents] = useState<ScoopEvent[]>([]);

  // 날짜 자동 롤오버 — 새벽 2시 기준. 태블릿을 켜둔 채 다음날이 되면 당일 생산일자로 무조건 갱신.
  //  (낮에 과거 날짜 조회 중엔 날짜가 안 바뀌므로 방해 없음. 새벽 2시 넘어갈 때만 당일로 이동)
  const effTodayRef = useRef(effectiveTodayKey());
  useEffect(() => {
    const id = setInterval(() => {
      const eff = effectiveTodayKey();
      if (eff !== effTodayRef.current) {
        effTodayRef.current = eff;
        setDate(eff);
      }
    }, 60_000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => onSnapshot(collection(db, 'days', date, 'items'), (s) => {
    const list: Item[] = [];
    s.forEach((d) => list.push(d.data() as Item));
    list.sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }));
    setItems(list);
  }), [date]);

  useEffect(() => onSnapshot(collection(db, 'days', date, 'scoop'), (s) => {
    const list: ScoopEvent[] = [];
    s.forEach((d) => list.push({ ...(d.data() as Omit<ScoopEvent, 'id'>), id: d.id }));
    setEvents(list);
  }), [date]);

  // 재배합 플래그 (날짜별, 실시간 공유): days/{date}/scoopFlags/{code} = { remix: bool }
  const [remixSet, setRemixSet] = useState<Set<string>>(new Set());
  useEffect(() => onSnapshot(collection(db, 'days', date, 'scoopFlags'), (s) => {
    const set = new Set<string>();
    s.forEach((d) => { if ((d.data() as any).remix) set.add(d.id); });
    setRemixSet(set);
  }), [date]);
  const toggleRemix = async (code: string, on: boolean) => {
    await setDoc(doc(db, 'days', date, 'scoopFlags', code), { code, remix: on, ts: Date.now() }, { merge: true });
  };

  // 품목별 합계 + 작업자별 합계 집계
  const byCode = useMemo(() => {
    const m = new Map<string, { total: number; byWorker: Map<string, number>; events: ScoopEvent[] }>();
    events.forEach((e) => {
      if (!m.has(e.code)) m.set(e.code, { total: 0, byWorker: new Map(), events: [] });
      const c = m.get(e.code)!;
      c.total += e.qty;
      c.byWorker.set(e.worker || '미지정', (c.byWorker.get(e.worker || '미지정') || 0) + e.qty);
      c.events.push(e);
    });
    return m;
  }, [events]);

  // 알림 설정 구독 (수신자·웹앱URL). onSnapshot 캐시로 값이 남아 읽기 없이도 마지막 값 사용 가능.
  const [notifyCfg, setNotifyCfg] = useState<{ enabled: boolean; emails: string; webAppUrl: string }>({ enabled: false, emails: '', webAppUrl: '' });
  useEffect(() => onSnapshot(doc(db, 'appMeta', 'notifySettings'), (s) => {
    const d = (s.data() || {}) as any;
    setNotifyCfg({ enabled: !!d.enabled, emails: d.emails || '', webAppUrl: d.webAppUrl || '' });
  }), []);

  // 내포장 진행률: (1) 요약문서 저장(폴링 백업) + (2) 100% 되면 Apps Script 로 직접 푸시(읽기 0, 즉시).
  const lastProgressRef = useRef('');
  useEffect(() => {
    if (date !== todayKey()) return;
    let totalTarget = 0, done = 0, completed = 0, itemCount = 0;
    items.forEach((it) => {
      const tg = it.totalQty || 0;
      if (tg <= 0) return;
      itemCount++;
      const d = byCode.get(it.code)?.total || 0;
      totalTarget += tg;
      done += Math.min(d, tg);
      if (d >= tg) completed++;
    });
    if (itemCount === 0) return;   // 오늘 품목 아직 없음
    const pct = totalTarget ? Math.round((done / totalTarget) * 100) : 0;

    // (1) 요약문서 저장 (값 바뀔 때만)
    const sig = `${pct}|${completed}|${itemCount}`;
    if (lastProgressRef.current !== sig) {
      lastProgressRef.current = sig;
      setDoc(doc(db, 'appMeta', 'scoopProgress'), {
        date, pct, completedItems: completed, itemCount, updatedAt: new Date().toISOString(),
      }, { merge: true }).catch(() => {});
    }

    // (2) 100% 푸시 — Firestore 읽기 없이 Apps Script 웹앱으로 직접 신호. 기기별 하루 1회.
    if (pct >= 100 && notifyCfg.enabled && notifyCfg.emails.trim() && notifyCfg.webAppUrl) {
      const key = 'scoopNotified:' + date;
      if (!localStorage.getItem(key)) {
        localStorage.setItem(key, '1');
        fetch(notifyCfg.webAppUrl, {
          method: 'POST', mode: 'no-cors', headers: { 'Content-Type': 'text/plain' },
          body: JSON.stringify({ type: 'scoopDone', date, completedItems: completed, itemCount, emails: notifyCfg.emails }),
        }).catch(() => {});
      }
    }
  }, [items, byCode, date, notifyCfg]);

  if (board) return <BoardView date={date} setDate={setDate} items={items} byCode={byCode} remixSet={remixSet} />;
  return <TabletView date={date} items={items} byCode={byCode} events={events} remixSet={remixSet} toggleRemix={toggleRemix} />;
}

/* ============================= 자리 태블릿 ============================= */
/** 앞에 붙은 [베본] 같은 접두어는 뗀다 */
const cleanName = (n: string) => (n || '').replace(/^\s*\[[^\]]*\]\s*/, '');

/** 설명 글은 화면에 늘어놓지 않고 ⓘ 를 눌렀을 때만 (태블릿은 마우스오버가 없다) */
function Info({ text, right }: { text: string; right?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <span className="relative inline-flex">
      <button type="button" onClick={() => setOpen((v) => !v)} aria-label="설명"
        className="w-7 h-7 rounded-full border border-gray-300 text-gray-500 text-sm font-bold bg-white active:bg-gray-100">ⓘ</button>
      {open && (
        <span onClick={() => setOpen(false)}
          className={`absolute z-30 top-9 ${right ? 'right-0' : 'left-0'} w-64 bg-gray-900 text-white text-xs leading-relaxed rounded-lg px-3 py-2 shadow-xl whitespace-pre-line`}>
          {text}
        </span>
      )}
    </span>
  );
}

function TabletView({
  date, items, byCode, events, remixSet, toggleRemix,
}: {
  date: string;
  items: Item[];
  byCode: Map<string, { total: number; byWorker: Map<string, number>; events: ScoopEvent[] }>;
  events: ScoopEvent[];
  remixSet: Set<string>;
  toggleRemix: (code: string, on: boolean) => void;
}) {
  // 작업자 이름은 그날만 — 어제 이름이 태블릿에 남아 있으면 지우고 매일 새로 받는다
  const [worker, setWorkerState] = useState<string>(() => {
    try { return localStorage.getItem(WORKER_DAY_KEY) === date ? (localStorage.getItem(WORKER_KEY) || '') : ''; } catch { return ''; }
  });
  const setWorker = (w: string) => {
    setWorkerState(w);
    try { localStorage.setItem(WORKER_KEY, w); localStorage.setItem(WORKER_DAY_KEY, date); } catch { /* 무시 */ }
  };
  // 새벽 2시에 날짜가 넘어가면 이름도 새로
  useEffect(() => {
    try { if (localStorage.getItem(WORKER_DAY_KEY) !== date) setWorkerState(''); } catch { /* 무시 */ }
  }, [date]);
  const [picked, setPicked] = useState<string>(() => localStorage.getItem(PICKED_KEY) || '');
  const [search, setSearch] = useState('');
  const [stageFilter, setStageFilter] = useState<string>('');   // '' = 전체
  const [showPicker, setShowPicker] = useState(false);
  const [manualQty, setManualQty] = useState<number>(0);
  // 글씨 크기 4단계 (보통 → 크게 → 아주크게 → 최대) — 기기별 저장
  const [textScale, setTextScale] = useState<number>(() => Number(localStorage.getItem('scoop:textScale')) || 0);
  useEffect(() => { localStorage.setItem('scoop:textScale', String(textScale)); }, [textScale]);
  const SZ: Record<string, string[]> = {
    code:        ['text-[16px]', 'text-[19px]', 'text-[23px]', 'text-[28px]'],
    name:        ['text-[26px]', 'text-[32px]', 'text-[40px]', 'text-[50px]'],
    chipLabel:   ['text-[13px]', 'text-[15px]', 'text-[18px]', 'text-[22px]'],
    chip:        ['text-[16px]', 'text-[19px]', 'text-[23px]', 'text-[28px]'],
    kpiLabel:    ['text-[14px]', 'text-[16px]', 'text-[20px]', 'text-[24px]'],
    kpiNum:      ['text-[28px]', 'text-[35px]', 'text-[44px]', 'text-[56px]'],
    bigBtn:      ['text-[28px]', 'text-[35px]', 'text-[44px]', 'text-[56px]'],
    undoBtn:     ['text-[28px]', 'text-[32px]', 'text-[38px]', 'text-[44px]'],   // 글자가 길어 한 단계씩 작게
    workerChip:  ['text-[13px]', 'text-[15px]', 'text-[18px]', 'text-[22px]'],
    manualLabel: ['text-[15px]', 'text-[18px]', 'text-[22px]', 'text-[26px]'],
    manualInput: ['text-[20px]', 'text-[24px]', 'text-[30px]', 'text-[36px]'],
    mine:        ['text-[15px]', 'text-[18px]', 'text-[22px]', 'text-[26px]'],
    pickerTab:   ['text-sm',  'text-base', 'text-lg', 'text-xl'],
    pickerCode:  ['text-sm', 'text-base', 'text-lg', 'text-xl'],
    pickerName:  ['text-lg', 'text-xl', 'text-2xl', 'text-3xl'],
    pickerQty:   ['text-base', 'text-lg', 'text-xl', 'text-2xl'],
  };
  const sz = (k: string) => SZ[k][textScale] || SZ[k][0];
  // 완바트 수량 표시용: productSettings 1회 로드 → canonicalShort 기준 맵
  const [prodMap, setProdMap] = useState<Map<string, ProductSetting>>(new Map());

  useEffect(() => { localStorage.setItem(PICKED_KEY, picked); }, [picked]);

  useEffect(() => {
    getDocs(collection(db, 'productSettings')).then((snap) => {
      const m = new Map<string, ProductSetting>();
      snap.forEach((d) => {
        const data = { ...(d.data() as ProductSetting), code: d.id };
        m.set(canonicalShort(d.id), data);
      });
      setProdMap(m);
    }).catch(() => {});
  }, []);

  // 현재 품목에 실제 존재하는 단계만 탭으로 (빈 단계 숨김)
  const presentStages = useMemo(() => {
    const set = new Set<string>();
    items.forEach((i) => { const s = getStage(i.code); if (s) set.add(s); });
    return STAGE_LETTERS.filter((s) => set.has(s));
  }, [items]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return items.filter((i) => {
      if (stageFilter && getStage(i.code) !== stageFilter) return false;
      if (q && !(i.code.toLowerCase().includes(q) || (i.name || '').toLowerCase().includes(q))) return false;
      return true;
    });
  }, [items, search, stageFilter]);

  const cur = items.find((i) => i.code === picked);
  const stat = picked ? byCode.get(picked) : undefined;
  const total = stat?.total || 0;
  const target = cur?.totalQty || 0;
  const remain = target - total;
  const myCount = worker && stat ? (stat.byWorker.get(worker) || 0) : 0;

  // 알림 띠 (되돌리기 · 저장 실패)
  const [toast, setToast] = useState<{ msg: string; undo?: () => void; err?: boolean } | null>(null);
  const toastTimer = useRef<number | undefined>(undefined);
  const showToast = (t: { msg: string; undo?: () => void; err?: boolean }) => {
    setToast(t);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 10_000);
  };
  useEffect(() => () => window.clearTimeout(toastTimer.current), []);

  // 누르면 바로 반영 — 서버 응답을 기다리지 않는다 (와이파이가 약해도 버튼이 멈추지 않게). 실패만 알린다.
  // 장갑 낀 손 두 번 눌림 방지로 0.3초만 잠근다
  const lockUntil = useRef(0);
  const addQty = (qty: number) => {
    if (!picked || !cur || !worker.trim() || qty === 0) return;
    const t = Date.now();
    if (t < lockUntil.current) return;
    lockUntil.current = t + 300;
    addDoc(collection(db, 'days', date, 'scoop'), {
      code: cur.code, name: cur.name || '', worker: worker.trim(), qty, ts: t,
    }).catch((e) => showToast({ msg: `⚠ 저장 실패 — 인터넷 연결을 확인하고 다시 눌러 주세요 (${e?.message || e})`, err: true }));
  };

  // 직전 취소 — 확인 창 없이 바로. 잘못 눌렀으면 10초 안에 「되돌리기」
  const undoLast = () => {
    if (!picked || !worker.trim()) return;
    const last = events
      .filter((e) => e.code === picked && (e.worker || '') === worker.trim())
      .sort((a, b) => b.ts - a.ts)[0];
    if (!last) return;
    deleteDoc(doc(db, 'days', date, 'scoop', last.id))
      .catch((e) => showToast({ msg: `⚠ 취소 저장 실패 — 다시 눌러 주세요 (${e?.message || e})`, err: true }));
    showToast({
      msg: `+${last.qty} 취소했습니다`,
      undo: () => {
        setDoc(doc(db, 'days', date, 'scoop', last.id), { code: last.code, name: last.name, worker: last.worker, qty: last.qty, ts: last.ts })
          .catch(() => {});
        setToast(null);
      },
    });
  };

  const toastEl = toast && (
    <div className={`fixed bottom-6 left-1/2 -translate-x-1/2 z-50 rounded-xl px-5 py-3 shadow-xl flex items-center gap-4 max-w-[92vw] ${toast.err ? 'bg-rose-600 text-white' : 'bg-gray-900 text-white'}`}>
      <span className="text-base">{toast.msg}</span>
      {toast.undo && <button onClick={toast.undo} className="px-4 py-2 rounded-lg bg-white/20 font-bold text-amber-300 whitespace-nowrap">↩ 되돌리기</button>}
    </div>
  );

  if (!worker.trim()) {
    return (
      <div className="max-w-[400px] mx-auto mt-12 bg-white rounded-2xl shadow p-6 space-y-4">
        <div className="flex items-center gap-2">
          <h2 className="text-xl font-bold">👤 작업자 이름</h2>
          <Info text={'이 태블릿에서 카운팅할 작업자 이름입니다.\n매일 새로 입력합니다 (새벽 2시에 바뀜).'} />
        </div>
        <WorkerSetup onSet={setWorker} />
      </div>
    );
  }

  const ps = cur ? prodMap.get(canonicalShort(cur.code)) : undefined;
  const pw = ps?.packWeight;
  const vat = ps?.vatMaxQty;
  const hasVat = vat !== undefined && vat !== null && vat > 0;
  // 상태 색: 부족 빨강 · 딱 맞음 초록 · 초과 보라(브랜드색)
  const st = target <= 0 ? 'none' : remain > 0 ? 'short' : remain === 0 ? 'done' : 'over';
  const stBox = { none: 'bg-slate-50', short: 'bg-rose-50', done: 'bg-emerald-50', over: 'bg-violet-50' }[st];
  const stText = { none: 'text-gray-500', short: 'text-rose-700', done: 'text-emerald-700', over: 'text-violet-700' }[st];
  const stBar = { none: 'bg-gray-300', short: 'bg-rose-500', done: 'bg-emerald-500', over: 'bg-violet-500' }[st];
  // 글씨를 많이 키우면 좁은 화면에서 2단이 넘치니 더 넓을 때만 2단
  const twoCol = textScale >= 2 ? 'xl:grid-cols-2' : 'min-[760px]:grid-cols-2';

  return (
    <div className="space-y-3 select-none">
      {/* 도구줄 — 날짜는 고정(오늘), 새벽 2시에 저절로 바뀐다 */}
      <div className="bg-white border rounded-lg px-3 py-2 flex items-center gap-2 flex-wrap">
        <span className="px-2.5 py-1.5 rounded-md bg-slate-100 text-sm font-bold tabular-nums">{date}</span>
        <span className="text-gray-300">|</span>
        <span className="text-sm text-gray-500">작업자</span>
        <span className="font-bold text-violet-700">{worker}</span>
        <button onClick={() => setWorker('')}
          className="px-3 py-2 rounded-lg bg-violet-600 text-white text-sm font-bold active:scale-95 transition whitespace-nowrap">
          🔄 작업자 변경
        </button>
        {cur && (
          <>
            <span className="text-gray-300">|</span>
            <button onClick={() => toggleRemix(cur.code, !remixSet.has(cur.code))}
              className={`px-3 py-2 rounded-lg text-sm font-bold border-2 whitespace-nowrap transition active:scale-95 ${
                remixSet.has(cur.code) ? 'bg-rose-500 text-white border-rose-500' : 'bg-white text-gray-500 border-gray-300'}`}>
              {remixSet.has(cur.code) ? '☑ 재배합' : '☐ 재배합'}
            </button>
            <button onClick={() => setShowPicker(true)}
              className="px-3 py-2 rounded-lg text-sm font-bold border-2 border-violet-300 bg-violet-50 text-violet-700 active:scale-95 transition whitespace-nowrap">
              🔄 품목 변경
            </button>
          </>
        )}
        <span className="ml-auto flex items-center gap-2">
          <Info right text={'실시간 공유 — 같은 품목을 여러 명이 동시에 세도 바로 합쳐집니다.\n날짜는 오늘로 고정 (새벽 2시에 바뀜).\n잘못 눌렀으면 「직전 취소」 (내가 넣은 마지막 1건).'} />
          <button onClick={() => setTextScale((textScale + 1) % 4)}
            className="px-3 py-2 rounded-lg text-sm font-bold border-2 border-gray-300 bg-white text-gray-600 whitespace-nowrap active:scale-95 transition">
            🔍 글씨 {['보통', '크게', '아주크게', '최대'][textScale]}
          </button>
        </span>
      </div>

      {/* 품목 선택 안내 */}
      {!picked || !cur ? (
        <div className="bg-violet-50 border-2 border-violet-200 rounded-2xl p-8 text-center">
          <div className="text-lg font-bold text-violet-800 mb-3">📦 작업할 품목을 선택하세요</div>
          <button onClick={() => setShowPicker(true)}
            className="px-8 py-4 bg-violet-600 text-white rounded-xl font-bold text-xl active:scale-95">
            품목 고르기
          </button>
        </div>
      ) : (
        <div className="bg-white border-2 border-violet-300 rounded-2xl p-4 shadow-sm space-y-4">
          {/* 정보 띠 — 포장중량 · 사용도구(냄비) 또는 1바트 수량 · 목표 바트 구성 */}
          {(pw || (vat !== undefined && vat !== null)) && (
            <div className="bg-slate-100 rounded-xl px-4 py-2.5 flex items-center gap-x-4 gap-y-2 flex-wrap">
              {pw ? (
                <span className="flex items-center gap-2">
                  <span className={`${sz('chipLabel')} text-gray-500 font-semibold`}>포장중량</span>
                  <span className={`px-3 py-1 rounded-lg bg-violet-100 text-violet-800 border border-violet-300 ${sz('chip')} font-extrabold tabular-nums`}>{pw.toLocaleString()}g</span>
                </span>
              ) : null}
              {vat === 999 ? (
                <span className="flex items-center gap-2">
                  <span className={`${sz('chipLabel')} text-gray-500 font-semibold`}>사용도구</span>
                  <span className={`px-3 py-1 rounded-lg bg-orange-100 text-orange-800 border border-orange-300 ${sz('chip')} font-extrabold`}>냄비</span>
                </span>
              ) : hasVat ? (
                <>
                  <span className="flex items-center gap-2">
                    <span className={`${sz('chipLabel')} text-gray-500 font-semibold`}>1바트</span>
                    <span className={`px-3 py-1 rounded-lg bg-sky-100 text-sky-800 border border-sky-300 ${sz('chip')} font-extrabold tabular-nums`}>{vat!.toLocaleString()}개</span>
                  </span>
                  {target > 0 && (
                    <span className="flex items-center gap-2">
                      <span className={`${sz('chipLabel')} text-gray-500 font-semibold`}>목표</span>
                      <span className={`px-3 py-1 rounded-lg bg-amber-100 text-amber-800 border border-amber-300 ${sz('chip')} font-extrabold tabular-nums`}>
                        {Math.floor(target / vat!)}바트{target % vat! > 0 ? ` + ${target % vat!}개` : ''}
                      </span>
                    </span>
                  )}
                </>
              ) : null}
            </div>
          )}

          <div className={`grid grid-cols-1 ${twoCol} gap-4`}>
            {/* 왼쪽 — 품목 · 숫자 · 진행 막대 · 작업자. 내 합계는 맨 아래(오른쪽 낱개 칸과 같은 줄) */}
            <div className="flex flex-col gap-3 min-w-0">
              <div>
                <div className={`${sz('code')} text-violet-600 font-bold tabular-nums`}>{cur.code}</div>
                <div className={`${sz('name')} font-bold text-gray-900 leading-tight truncate`}>{cleanName(cur.name || cur.code)}</div>
              </div>
              <div className="grid grid-cols-3 gap-2 text-center">
                <div className="bg-slate-50 rounded-xl py-3">
                  <div className={`${sz('kpiLabel')} text-gray-500`}>목표</div>
                  <div className={`${sz('kpiNum')} font-bold text-gray-900 tabular-nums leading-tight`}>{target.toLocaleString()}</div>
                </div>
                <div className="bg-emerald-50 rounded-xl py-3">
                  <div className={`${sz('kpiLabel')} text-emerald-700`}>현재</div>
                  <div className={`${sz('kpiNum')} font-bold text-emerald-700 tabular-nums leading-tight`}>{total.toLocaleString()}</div>
                </div>
                <div className={`rounded-xl py-3 ${stBox}`}>
                  <div className={`${sz('kpiLabel')} ${stText}`}>{st === 'over' ? '초과' : st === 'done' ? '완료' : '부족'}</div>
                  <div className={`${sz('kpiNum')} font-bold tabular-nums leading-tight ${stText}`}>{Math.abs(remain).toLocaleString()}</div>
                </div>
              </div>
              <div className="h-5 bg-gray-100 rounded-full overflow-hidden">
                <div className={`h-full transition-all ${stBar}`}
                  style={{ width: `${target > 0 ? Math.min(100, (total / target) * 100) : 0}%` }} />
              </div>
              {stat && stat.byWorker.size > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {Array.from(stat.byWorker.entries())
                    .sort((a, b) => b[1] - a[1])
                    .map(([w, q]) => (
                      <span key={w}
                        className={`px-2.5 py-1 rounded-full tabular-nums ${sz('workerChip')} ${w === worker ? 'bg-violet-600 text-white font-bold' : 'bg-gray-100 text-gray-700'}`}>
                        {w} {q.toLocaleString()}
                      </span>
                    ))}
                </div>
              )}
              <div className={`mt-auto bg-slate-50 border rounded-xl py-3 text-center ${sz('mine')} text-gray-600`}>
                내 합계(<span className="font-bold text-violet-700">{worker}</span>): <span className="font-bold text-violet-700 tabular-nums">{myCount.toLocaleString()}</span>개
              </div>
            </div>

            {/* 오른쪽 — 큰 버튼 (손 쪽). 왼쪽 단 높이만큼 세로로 꽉 채우고, 낱개는 맨 아래 */}
            <div className="flex flex-col gap-3">
              <div className="flex-1 grid grid-cols-2 gap-3 min-h-[200px]">
                <button onClick={() => addQty(20)}
                  className={`h-full bg-violet-600 text-white rounded-2xl ${sz('bigBtn')} font-bold active:scale-95 active:bg-violet-700 transition shadow tabular-nums`}>
                  + 20
                </button>
                <button onClick={undoLast}
                  className={`h-full px-2 bg-white border-2 border-rose-400 text-rose-600 rounded-2xl ${sz('undoBtn')} leading-tight font-bold active:scale-95 active:bg-rose-50 transition`}>
                  ↶ 직전 취소
                </button>
              </div>
              {/* 낱개 — 20개 단위가 아닌 나머지. 숫자칸을 누를 때만 키보드가 뜬다 */}
              <div className="bg-slate-50 border rounded-xl p-3 flex items-center gap-2">
                <span className={`${sz('manualLabel')} text-gray-600 font-semibold`}>낱개</span>
                <input type="number" inputMode="numeric" value={manualQty || ''} onChange={(e) => setManualQty(Number(e.target.value) || 0)}
                  className={`flex-1 min-w-0 border rounded-lg px-3 py-2 text-center font-bold tabular-nums ${sz('manualInput')}`} placeholder="예: 6" />
                <button onClick={() => { if (manualQty > 0) { addQty(manualQty); setManualQty(0); } }}
                  disabled={manualQty <= 0}
                  className={`px-5 py-3 bg-emerald-600 text-white rounded-lg font-bold ${sz('manualLabel')} active:scale-95 disabled:bg-gray-300`}>
                  + 추가
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 품목 선택 모달 */}
      {showPicker && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-3" onClick={() => setShowPicker(false)}>
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-3xl h-[92vh] flex flex-col overflow-hidden" onClick={(e) => e.stopPropagation()}>
            <div className="px-5 py-3 border-b flex items-center justify-between bg-violet-50">
              <h3 className="font-bold text-lg">품목 선택</h3>
              <button onClick={() => setShowPicker(false)} aria-label="닫기" className="w-11 h-11 rounded-full text-2xl text-gray-500 active:bg-gray-200">×</button>
            </div>
            <div className="p-3 border-b space-y-2">
              <input value={search} onChange={(e) => setSearch(e.target.value)}
                placeholder="🔍 코드 또는 품목명…"
                className="w-full border rounded-lg px-4 py-3 text-lg" />
              {/* 단계 탭 — 그날 있는 단계만 */}
              <div className="flex flex-wrap gap-2">
                <button onClick={() => setStageFilter('')}
                  className={`px-4 py-2.5 rounded-lg ${sz('pickerTab')} font-bold active:scale-95 transition ${stageFilter === '' ? 'bg-violet-600 text-white' : 'bg-gray-100 text-gray-600'}`}>
                  전체
                </button>
                {presentStages.map((s) => (
                  <button key={s} onClick={() => setStageFilter(s)}
                    className={`px-4 py-2.5 rounded-lg ${sz('pickerTab')} font-bold active:scale-95 transition ${stageFilter === s ? 'bg-violet-600 text-white' : 'bg-gray-100 text-gray-600'}`}>
                    {s}
                  </button>
                ))}
              </div>
            </div>
            <div className="flex-1 overflow-y-auto overscroll-contain">
              {filtered.length === 0 ? (
                <div className="p-12 text-center text-gray-400">{items.length === 0 ? '오늘 등록된 품목이 없습니다.' : '검색 결과가 없습니다.'}</div>
              ) : (
                <ul className="divide-y">
                  {filtered.map((it) => {
                    const s = byCode.get(it.code);
                    const done = s?.total || 0;
                    const tg = it.totalQty || 0;
                    const pct = tg > 0 ? Math.min(100, (done / tg) * 100) : 0;
                    const workerCount = s?.byWorker.size || 0;
                    // 부족 빨강 · 딱 맞음 초록 · 초과 보라 (목표 0 = 회색)
                    const r = tg - done;
                    const started = done > 0;
                    const bar = tg <= 0 ? 'bg-gray-300' : r > 0 ? 'bg-rose-500' : r === 0 ? 'bg-emerald-500' : 'bg-violet-500';
                    const numCls = !started ? 'text-gray-500' : r > 0 ? 'text-rose-600' : r === 0 ? 'text-emerald-700' : 'text-violet-700';
                    return (
                      <li key={it.code}>
                        <button onClick={() => { setPicked(it.code); setShowPicker(false); setSearch(''); }}
                          className={`w-full text-left px-4 py-4 active:bg-violet-100 flex items-center gap-4 ${it.code === picked ? 'bg-violet-50' : ''}`}>
                          <div className="flex-1 min-w-0">
                            <div className={`${sz('pickerCode')} font-bold text-violet-600 tabular-nums`}>{it.code}</div>
                            <div className={`${sz('pickerName')} font-bold text-gray-900 truncate`}>{cleanName(it.name)}</div>
                            <div className="mt-1.5 h-2 bg-gray-100 rounded-full overflow-hidden">
                              <div className={`h-full ${bar}`} style={{ width: `${pct}%` }} />
                            </div>
                          </div>
                          <div className="text-right whitespace-nowrap">
                            <div className={`${sz('pickerQty')} tabular-nums`}>
                              <span className={`font-bold ${numCls}`}>{done.toLocaleString()}</span>
                              <span className="text-gray-400"> / {tg.toLocaleString()}</span>
                            </div>
                            {workerCount > 0 && <div className="text-xs text-gray-500">{workerCount}명 작업중</div>}
                          </div>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </div>
        </div>
      )}
      {toastEl}
    </div>
  );
}

/** 작업자 이름 — 근태에 등록된 인원이 자동완성으로 뜬다. 근태에 없는 사람은 「외부인원」 체크 후 입력 */
function WorkerSetup({ onSet }: { onSet: (w: string) => void }) {
  const [v, setV] = useState('');
  const [outsider, setOutsider] = useState(false);
  const [names, setNames] = useState<string[] | null>(null);   // null = 불러오는 중
  useEffect(() => {
    getDocs(collection(db, 'members')).then((snap) => {
      const a: string[] = [];
      snap.forEach((d) => { const m = d.data() as Member; if (m.name?.trim() && m.active !== false) a.push(m.name.trim()); });
      setNames([...new Set(a)].sort((x, y) => x.localeCompare(y, 'ko')));
    }).catch(() => setNames([]));
  }, []);
  const t = v.trim();
  const known = !!names && names.includes(t);
  // 근태 명단을 못 불러왔으면(인터넷 등) 막지 않는다
  const noList = names !== null && names.length === 0;
  const canStart = !!t && (outsider || known || noList);
  const sugg = t && names ? names.filter((n) => n.includes(t) && n !== t).slice(0, 8) : [];
  const start = () => { if (canStart) onSet(t); };
  return (
    <div className="space-y-3">
      <div className="flex gap-2">
        <input value={v} onChange={(e) => setV(e.target.value)} placeholder="이름"
          className="flex-1 min-w-0 border-2 rounded-lg px-4 py-3 text-lg" autoFocus
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) start(); }} />
        <button onClick={start} disabled={!canStart}
          className="px-5 py-3 bg-violet-600 text-white rounded-lg font-bold text-lg disabled:bg-gray-300">
          시작
        </button>
      </div>
      {sugg.length > 0 && (
        <div className="grid grid-cols-2 gap-2">
          {sugg.map((n) => (
            <button key={n} onClick={() => setV(n)}
              className="py-3 rounded-lg border-2 border-violet-200 bg-violet-50 text-violet-800 font-bold text-lg active:scale-95">{n}</button>
          ))}
        </div>
      )}
      {t && !known && !outsider && !noList && names !== null && sugg.length === 0 && (
        <div className="text-sm text-rose-600">근태에 없는 이름입니다. 외부인원이면 아래를 체크하세요.</div>
      )}
      <label className="flex items-center gap-2 text-sm text-gray-700">
        <input type="checkbox" checked={outsider} onChange={(e) => setOutsider(e.target.checked)} className="w-5 h-5" />
        외부인원 (근태 미등록자도 입력 가능)
      </label>
    </div>
  );
}

/* =============================== 현황판 ============================== */
function BoardView({
  date, setDate, items, byCode, remixSet,
}: {
  date: string;
  setDate: (d: string) => void;
  items: Item[];
  byCode: Map<string, { total: number; byWorker: Map<string, number>; events: ScoopEvent[] }>;
  remixSet: Set<string>;
}) {
  const rows = items.map((it) => {
    const s = byCode.get(it.code);
    const done = s?.total || 0;
    const tg = it.totalQty || 0;
    const remain = tg - done;
    return { it, s, done, tg, remain, pct: tg > 0 ? Math.min(100, (done / tg) * 100) : 0 };
  });
  const remixItems = rows.filter((r) => remixSet.has(r.it.code));
  const active = rows.filter((r) => r.s && r.s.total > 0);
  // 정렬: 남음(remain>0) → 완료(remain=0) → 초과(remain<0)
  //  현장 직책자가 부족한 품목을 즉시 보도록.
  const statusOrder = (remain: number) => remain > 0 ? 0 : remain === 0 ? 1 : 2;
  active.sort((a, b) => {
    const so = statusOrder(a.remain) - statusOrder(b.remain);
    if (so !== 0) return so;
    if (a.remain > 0 && b.remain > 0) return b.remain - a.remain;       // 남음 많은 순
    if (a.remain < 0 && b.remain < 0) return a.remain - b.remain;       // 초과 많은 순(절대값 큰 게 위)
    return a.it.code.localeCompare(b.it.code);
  });
  const totalTarget = rows.reduce((sum, r) => sum + r.tg, 0);
  const totalDone = rows.reduce((sum, r) => sum + r.done, 0);
  const overall = totalTarget > 0 ? (totalDone / totalTarget) * 100 : 0;

  // 단계별 진척: 그날 단계별 품목수 중 '완료(딱 맞음) + 초과' 만 카운트 (부족은 미카운트)
  const stageProgress = useMemo(() => {
    const m = new Map<string, { total: number; doneCnt: number }>();
    rows.forEach((r) => {
      if (r.tg <= 0) return;
      const s = getStage(r.it.code);
      if (!s) return;
      const e = m.get(s) || { total: 0, doneCnt: 0 };
      e.total += 1;
      if (r.remain <= 0) e.doneCnt += 1;     // 완료(=0) + 초과(<0)
      m.set(s, e);
    });
    return STAGE_LETTERS.filter((s) => m.has(s)).map((s) => ({ stage: s, ...m.get(s)! }));
  }, [rows]);

  return (
    <div className="space-y-3">
      <div className="bg-white border rounded-lg p-3 flex items-center gap-3 flex-wrap">
        <span className="text-lg font-bold">📺 내포장 현황판</span>
        <input type="date" value={date} onChange={(e) => e.target.value && setDate(e.target.value)}
          className="border rounded px-2 py-1 text-sm font-bold" />
        <span className="ml-auto text-sm text-gray-500">실시간 자동 갱신</span>
      </div>

      {/* 재배합 필요 — 최우선 표시 */}
      {remixItems.length > 0 && (
        <div className="bg-rose-50 border-2 border-rose-400 rounded-xl overflow-hidden shadow-sm">
          <div className="px-4 py-2.5 bg-rose-500 text-white font-bold flex items-center gap-2">
            <span className="text-lg">🔄</span> 재배합 필요 ({remixItems.length})
          </div>
          <div className="divide-y divide-rose-100">
            {remixItems.map(({ it, done, tg, remain }) => (
              <div key={it.code} className="px-4 py-3 flex items-center justify-between gap-3">
                <div className="flex-1 min-w-0">
                  <div className="text-[11px] text-rose-400 font-mono">{it.code}</div>
                  <div className="font-bold text-rose-900 truncate">{it.name}</div>
                </div>
                <div className="text-right whitespace-nowrap">
                  <div className="text-lg">
                    <span className="font-bold text-rose-700">{done.toLocaleString()}</span>
                    <span className="text-gray-400 text-base"> / {tg.toLocaleString()}</span>
                  </div>
                  {remain > 0 && <div className="text-xs text-rose-600 font-bold">부족 {remain.toLocaleString()}</div>}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* KPI */}
      <div className="grid grid-cols-3 gap-3">
        <div className="bg-slate-50 border rounded-xl p-4 text-center">
          <div className="text-xs text-gray-500">전체 목표</div>
          <div className="text-3xl font-bold">{totalTarget.toLocaleString()}</div>
        </div>
        <div className="bg-emerald-50 border-emerald-200 border rounded-xl p-4 text-center">
          <div className="text-xs text-emerald-700">현재</div>
          <div className="text-3xl font-bold text-emerald-700">{totalDone.toLocaleString()}</div>
          <div className="text-xs text-emerald-600">{overall.toFixed(1)}%</div>
        </div>
        <div className="bg-violet-50 border-violet-200 border rounded-xl p-4 text-center">
          <div className="text-xs text-violet-700">진행중</div>
          <div className="text-3xl font-bold text-violet-700">{active.length}<span className="text-base">품목</span></div>
        </div>
      </div>

      {/* 단계별 진척 — 완료+초과 / 전체 (부족 미카운트) */}
      {stageProgress.length > 0 && (
        <div className="bg-white border rounded-xl p-3">
          <div className="text-xs font-bold text-gray-500 mb-2 px-1">단계별 완료</div>
          <div className="grid grid-flow-col auto-cols-fr gap-2">
            {stageProgress.map((sp) => {
              const allDone = sp.doneCnt >= sp.total;
              const pct = sp.total > 0 ? (sp.doneCnt / sp.total) * 100 : 0;
              return (
                <div key={sp.stage}
                  className={`rounded-lg px-3 py-2.5 text-center border-2 transition ${
                    allDone
                      ? 'bg-emerald-50 border-emerald-400'
                      : sp.doneCnt > 0 ? 'bg-white border-gray-200' : 'bg-gray-50 border-gray-200'
                  }`}>
                  <div className={`text-base font-extrabold mb-1 ${allDone ? 'text-emerald-700' : 'text-gray-700'}`}>
                    {sp.stage === 'F500' ? 'F-500' : sp.stage}
                  </div>
                  <div className="flex items-baseline justify-center gap-1">
                    <span className={`text-2xl font-bold leading-none ${allDone ? 'text-emerald-700' : 'text-gray-800'}`}>{sp.doneCnt}</span>
                    <span className="text-sm text-gray-400">/ {sp.total}</span>
                  </div>
                  <div className="mt-1.5 h-1 bg-gray-100 rounded-full overflow-hidden">
                    <div className={`h-full ${allDone ? 'bg-emerald-500' : 'bg-violet-400'}`} style={{ width: `${pct}%` }} />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* 작업중인 품목 */}
      <div className="bg-white border-2 border-violet-200 rounded-xl overflow-hidden">
        <div className="px-4 py-2 bg-violet-50 font-bold text-violet-800 text-sm">진행중 ({active.length})</div>
        {active.length === 0 ? (
          <div className="p-8 text-center text-gray-400 text-sm">현재 작업중인 품목이 없습니다.</div>
        ) : (
          <div className="divide-y">
            {active.map(({ it, s, done, tg, remain, pct }) => (
              <div key={it.code} className="px-4 py-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="text-[11px] text-gray-400 font-mono">{it.code}</div>
                    <div className="font-bold truncate">{it.name}</div>
                  </div>
                  <div className="text-right whitespace-nowrap">
                    <div className="text-xl">
                      <span className={`font-bold ${remain > 0 ? 'text-rose-600' : remain === 0 ? 'text-emerald-700' : 'text-violet-700'}`}>{done.toLocaleString()}</span>
                      <span className="text-gray-400 text-base"> / {tg.toLocaleString()}</span>
                    </div>
                    {remain > 0 ? (
                      <div className="text-xs text-rose-600 font-bold">부족 {remain.toLocaleString()}</div>
                    ) : remain < 0 ? (
                      <div className="text-xs text-violet-600 font-bold">초과 {Math.abs(remain).toLocaleString()}</div>
                    ) : (
                      <div className="text-xs text-emerald-600 font-bold">완료 ✓</div>
                    )}
                  </div>
                </div>
                <div className="mt-2 h-2.5 bg-gray-100 rounded-full overflow-hidden">
                  <div className={`h-full ${remain > 0 ? 'bg-rose-500' : remain === 0 ? 'bg-emerald-500' : 'bg-violet-500'}`} style={{ width: `${pct}%` }} />
                </div>
                {s && s.byWorker.size > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1.5 text-xs">
                    {Array.from(s.byWorker.entries()).sort((a, b) => b[1] - a[1]).map(([w, q]) => (
                      <span key={w} className="px-2 py-0.5 rounded-full bg-violet-100 text-violet-700">
                        {w} <span className="font-bold">{q.toLocaleString()}</span>
                      </span>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 작업자별 오늘 누적 — 품목 상관없이 총 푼 개수 (맨 아래) */}
      {(() => {
        const totals = new Map<string, number>();
        byCode.forEach((c) => c.byWorker.forEach((q, w) => totals.set(w, (totals.get(w) || 0) + q)));
        const arr = Array.from(totals.entries()).sort((a, b) => b[1] - a[1]);
        if (arr.length === 0) return null;
        const max = arr[0][1] || 1;
        return (
          <div className="bg-white border rounded-xl overflow-hidden">
            <div className="px-4 py-2.5 bg-slate-50 border-b font-bold text-gray-700 text-sm flex items-center gap-2">
              👥 작업자별 오늘 누적
              <span className="text-xs font-normal text-gray-400">({arr.length}명)</span>
            </div>
            <div className="p-3 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-2.5">
              {arr.map(([w, q]) => (
                <div key={w} className="rounded-xl px-3 py-2.5 border bg-violet-50 border-violet-200">
                  <div className="font-bold text-violet-800 truncate">{w}</div>
                  <div className="text-2xl font-extrabold tabular-nums text-violet-700">
                    {q.toLocaleString()}<span className="text-xs font-normal ml-1 text-gray-400">개</span>
                  </div>
                  <div className="mt-1.5 h-1.5 rounded-full overflow-hidden bg-violet-100">
                    <div className="h-full bg-violet-500" style={{ width: `${(q / max) * 100}%` }} />
                  </div>
                </div>
              ))}
            </div>
          </div>
        );
      })()}
    </div>
  );
}
