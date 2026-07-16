/** 내포장 죽 카운팅 (자리 태블릿) + 현황판
 *  - 작업자가 자리에서 품목 선택 → +20/낱개 버튼으로 카운팅
 *  - 같은 품목을 여러 명이 동시에 풀면 풀(pool)에 합산. 실시간 공유.
 *  - 데이터: days/{date}/scoop/{auto}  =  { code, name, worker, qty, ts }
 *  - 작업자 이름은 기기별 localStorage 에 저장
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { addDoc, collection, deleteDoc, doc, getDocs, onSnapshot, setDoc } from 'firebase/firestore';
import { db } from '../firebase';
import type { Item, ProductSetting } from '../types';
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
  return <TabletView date={date} setDate={setDate} items={items} byCode={byCode} events={events} remixSet={remixSet} toggleRemix={toggleRemix} />;
}

/* ============================= 자리 태블릿 ============================= */
function TabletView({
  date, setDate, items, byCode, events, remixSet, toggleRemix,
}: {
  date: string;
  setDate: (d: string) => void;
  items: Item[];
  byCode: Map<string, { total: number; byWorker: Map<string, number>; events: ScoopEvent[] }>;
  events: ScoopEvent[];
  remixSet: Set<string>;
  toggleRemix: (code: string, on: boolean) => void;
}) {
  const [worker, setWorker] = useState<string>(() => localStorage.getItem(WORKER_KEY) || '');
  const [picked, setPicked] = useState<string>(() => localStorage.getItem(PICKED_KEY) || '');
  const [search, setSearch] = useState('');
  const [stageFilter, setStageFilter] = useState<string>('');   // '' = 전체
  const [showPicker, setShowPicker] = useState(false);
  const [manualQty, setManualQty] = useState<number>(0);
  const [saving, setSaving] = useState(false);
  // 글씨 크기 단계 (0=보통,1=크게,2=아주크게) — 기기별 저장. 텍스트 크기만 키워 레이아웃 유지.
  const [textScale, setTextScale] = useState<number>(() => Number(localStorage.getItem('scoop:textScale')) || 0);
  useEffect(() => { localStorage.setItem('scoop:textScale', String(textScale)); }, [textScale]);
  const SZ: Record<string, string[]> = {
    code:        ['text-lg',  'text-xl',  'text-2xl', 'text-3xl'],
    name:        ['text-2xl', 'text-3xl', 'text-4xl', 'text-5xl'],
    chip:        ['text-sm',  'text-base', 'text-lg', 'text-xl'],
    packChip:    ['text-base', 'text-lg', 'text-xl', 'text-2xl'],
    packBig:     ['text-xl',  'text-2xl', 'text-3xl', 'text-4xl'],
    bannerLabel: ['text-sm',  'text-base', 'text-xl', 'text-2xl'],
    bannerBig:   ['text-3xl', 'text-4xl', 'text-5xl', 'text-6xl'],
    bannerUnit:  ['text-xl',  'text-2xl', 'text-3xl', 'text-4xl'],
    kpiLabel:    ['text-xs',  'text-sm',  'text-lg', 'text-xl'],
    kpiNum:      ['text-2xl', 'text-3xl', 'text-4xl', 'text-5xl'],
    bigBtn:      ['text-3xl', 'text-4xl', 'text-5xl', 'text-6xl'],
    subBtn:      ['text-xl',  'text-2xl', 'text-3xl', 'text-4xl'],
    manualLabel: ['text-sm',  'text-base', 'text-lg', 'text-xl'],
    manualInput: ['text-lg',  'text-xl',  'text-2xl', 'text-3xl'],
    mine:        ['text-sm',  'text-base', 'text-lg', 'text-xl'],
    pickerTab:   ['text-sm',  'text-base', 'text-lg', 'text-xl'],
    pickerCode:  ['text-base', 'text-lg', 'text-xl', 'text-2xl'],
    pickerName:  ['text-base', 'text-lg', 'text-xl', 'text-2xl'],
    pickerQty:   ['text-sm',  'text-base', 'text-lg', 'text-xl'],
  };
  const sz = (k: string) => SZ[k][textScale] || SZ[k][0];
  // 완바트 수량 표시용: productSettings 1회 로드 → canonicalShort 기준 맵
  const [prodMap, setProdMap] = useState<Map<string, ProductSetting>>(new Map());

  useEffect(() => { localStorage.setItem(WORKER_KEY, worker); }, [worker]);
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

  const addQty = async (qty: number) => {
    if (!picked || !cur || !worker.trim() || qty === 0) return;
    setSaving(true);
    try {
      await addDoc(collection(db, 'days', date, 'scoop'), {
        code: cur.code, name: cur.name || '', worker: worker.trim(), qty, ts: Date.now(),
      });
    } finally { setSaving(false); }
  };

  const undoLast = async () => {
    if (!picked || !worker.trim()) return;
    const mine = events
      .filter((e) => e.code === picked && (e.worker || '') === worker.trim())
      .sort((a, b) => b.ts - a.ts);
    const last = mine[0];
    if (!last) return;
    if (!confirm(`마지막 +${last.qty} 취소할까요?`)) return;
    await deleteDoc(doc(db, 'days', date, 'scoop', last.id)).catch(() => {});
  };

  if (!worker.trim()) {
    return (
      <div className="max-w-md mx-auto mt-12 bg-white rounded-2xl shadow p-6 space-y-4">
        <h2 className="text-xl font-bold">👤 작업자 이름</h2>
        <p className="text-sm text-gray-500">이 태블릿에서 카운팅할 작업자 이름을 한 번만 등록하세요.</p>
        <WorkerSetup onSet={setWorker} />
      </div>
    );
  }

  return (
    <div className="space-y-3 select-none">
      {/* 상단바 */}
      <div className="bg-white border rounded-lg p-3 flex items-center gap-3 flex-wrap">
        <span className="text-sm text-gray-500">날짜</span>
        <input type="date" value={date} onChange={(e) => e.target.value && setDate(e.target.value)}
          className="border rounded px-2 py-1 text-sm font-bold" />
        <span className="text-gray-300">|</span>
        <span className="text-sm text-gray-500">작업자</span>
        <span className="font-bold text-violet-700">{worker}</span>
        <button onClick={() => setWorker('')}
          className="px-4 py-2 rounded-lg bg-violet-600 text-white text-sm font-bold hover:bg-violet-700 active:scale-95 transition shadow-sm whitespace-nowrap">
          🔄 작업자 변경
        </button>
        <span className="ml-auto text-xs text-gray-400">실시간 공유 · 여러 명 동시 작업 가능</span>
      </div>

      {/* 품목 선택 카드 */}
      {!picked || !cur ? (
        <div className="bg-violet-50 border-2 border-violet-200 rounded-2xl p-8 text-center">
          <div className="text-lg font-bold text-violet-800 mb-3">📦 작업할 품목을 선택하세요</div>
          <button onClick={() => setShowPicker(true)}
            className="px-6 py-3 bg-violet-600 text-white rounded-xl font-bold text-lg hover:bg-violet-700">
            품목 고르기
          </button>
        </div>
      ) : (
        <div className="bg-white border-2 border-violet-300 rounded-2xl p-5 shadow-sm">
          <div className="flex items-start justify-between gap-3">
            <div className="flex-1 min-w-0">
              <div className={`${sz('code')} text-violet-600 font-mono font-bold`}>{cur.code}</div>
              {/* 품목명 — 긴 이름은 말줄임(…) 처리해 칩과 충돌 방지 */}
              <div className={`${sz('name')} font-bold text-gray-800 truncate`}>{cur.name || cur.code}</div>
              {/* 칩 줄 — 이름과 분리해서 항상 아래에 깔끔히 배치 */}
              <div className="flex items-center gap-2 flex-wrap mt-1.5">
                {(() => {
                  const v = prodMap.get(canonicalShort(cur.code))?.vatMaxQty;
                  if (v === undefined || v === null) return null;
                  if (v === 999) {
                    return (
                      <span className={`px-2.5 py-1 bg-orange-100 text-orange-700 border border-orange-300 rounded-full ${sz('chip')} font-bold whitespace-nowrap`}>
                        냄비
                      </span>
                    );
                  }
                  return (
                    <span className={`px-2.5 py-1 bg-cyan-100 text-cyan-700 border border-cyan-300 rounded-full ${sz('chip')} font-bold whitespace-nowrap`}>
                      1바트 = {v.toLocaleString()}개
                    </span>
                  );
                })()}
              </div>
            </div>
            <div className="flex items-center gap-3">
              <button onClick={() => setTextScale((textScale + 1) % 4)}
                title="글씨 크기 조정 (보통 → 크게 → 아주크게 → 최대)"
                className="px-4 py-3 rounded-xl text-base font-bold border-2 border-gray-300 bg-white text-gray-600 hover:bg-gray-50 whitespace-nowrap active:scale-95 transition">
                🔍 글씨 {['보통', '크게', '아주크게', '최대'][textScale]}
              </button>
              <button onClick={() => toggleRemix(cur.code, !remixSet.has(cur.code))}
                className={`px-4 py-3 rounded-xl text-base font-bold border-2 whitespace-nowrap transition active:scale-95 ${
                  remixSet.has(cur.code)
                    ? 'bg-rose-500 text-white border-rose-500 shadow'
                    : 'bg-white text-gray-500 border-gray-300 hover:bg-gray-50'
                }`}>
                {remixSet.has(cur.code) ? '☑ 재배합' : '☐ 재배합'}
              </button>
              <button onClick={() => setShowPicker(true)}
                className="px-5 py-3 bg-violet-100 text-violet-700 border-2 border-violet-300 rounded-xl text-base font-bold hover:bg-violet-200 active:scale-95 transition whitespace-nowrap shadow-sm">
                🔄 품목 변경
              </button>
            </div>
          </div>

          {/* 가운데 정보 배너 — 포장중량(크게) + 오늘 목표 바트 구성 */}
          {(() => {
            const ps = prodMap.get(canonicalShort(cur.code));
            const v = ps?.vatMaxQty;
            const w = ps?.packWeight;
            const hasBat = !!v && v !== 999;
            if (!w && !hasBat) return null;
            const fullVats = hasBat ? Math.floor(target / (v as number)) : 0;
            const partial = hasBat ? target - fullVats * (v as number) : 0;
            return (
              <div className="mt-3 bg-amber-50 border-2 border-amber-300 rounded-xl px-4 py-3 flex items-center justify-center gap-x-6 gap-y-2 flex-wrap">
                {w && (
                  <span className={`inline-flex items-center px-4 py-2 bg-emerald-100 text-emerald-800 border-2 border-emerald-400 rounded-xl ${sz('packBig')} font-extrabold shadow-sm whitespace-nowrap`}>
                    포장중량 {w.toLocaleString()}g
                  </span>
                )}
                {hasBat && (
                  <span className="flex items-center justify-center gap-2 flex-wrap">
                    <span className={`${sz('bannerLabel')} font-bold text-amber-700`}>오늘 목표 {target.toLocaleString()}개 =</span>
                    <span className={`${sz('bannerBig')} font-extrabold text-amber-800 tabular-nums`}>{fullVats}<span className={`${sz('bannerUnit')} ml-0.5`}>바트</span></span>
                    {partial > 0 && (
                      <>
                        <span className={`${sz('bannerUnit')} font-bold text-amber-500`}>+</span>
                        <span className={`${sz('bannerBig')} font-extrabold text-amber-800 tabular-nums`}>{partial}<span className={`${sz('bannerUnit')} ml-0.5`}>개</span></span>
                      </>
                    )}
                  </span>
                )}
              </div>
            );
          })()}

          {/* 진행률 큰 표시 */}
          <div className="mt-4 grid grid-cols-3 gap-3 text-center">
            <div className="bg-slate-50 rounded-lg p-3">
              <div className={`${sz('kpiLabel')} text-gray-500`}>목표</div>
              <div className={`${sz('kpiNum')} font-bold text-gray-800`}>{target.toLocaleString()}</div>
            </div>
            <div className="bg-emerald-50 rounded-lg p-3">
              <div className={`${sz('kpiLabel')} text-emerald-700`}>현재</div>
              <div className={`${sz('kpiNum')} font-bold text-emerald-700`}>{total.toLocaleString()}</div>
            </div>
            <div className={`rounded-lg p-3 ${remain > 0 ? 'bg-rose-50' : remain === 0 && total > 0 ? 'bg-emerald-50' : remain < 0 ? 'bg-violet-50' : 'bg-slate-50'}`}>
              <div className={`${sz('kpiLabel')} ${remain > 0 ? 'text-rose-700' : remain === 0 && total > 0 ? 'text-emerald-700' : remain < 0 ? 'text-violet-700' : 'text-gray-500'}`}>{remain > 0 ? '부족' : remain < 0 ? '초과' : (total > 0 ? '완료' : '부족')}</div>
              <div className={`${sz('kpiNum')} font-bold ${remain > 0 ? 'text-rose-700' : remain === 0 && total > 0 ? 'text-emerald-700' : remain < 0 ? 'text-violet-700' : 'text-gray-700'}`}>{Math.abs(remain).toLocaleString()}</div>
            </div>
          </div>

          {/* 진행 바 — 현황판과 색 통일: 부족=빨강 / 완료=초록 / 초과=보라 */}
          <div className="mt-3 h-4 bg-gray-100 rounded-full overflow-hidden">
            <div
              className={`h-full transition-all ${
                target <= 0 ? 'bg-gray-300'
                : remain > 0 ? 'bg-rose-500'
                : remain === 0 ? 'bg-emerald-500'
                : 'bg-violet-500'
              }`}
              style={{ width: `${target > 0 ? Math.min(100, (total / target) * 100) : 0}%` }}
            />
          </div>

          {/* 작업자별 합계 (같은 풀) */}
          {stat && stat.byWorker.size > 0 && (
            <div className="mt-3 flex flex-wrap gap-2 text-xs">
              {Array.from(stat.byWorker.entries())
                .sort((a, b) => b[1] - a[1])
                .map(([w, q]) => (
                  <span key={w}
                    className={`px-2 py-1 rounded-full ${w === worker ? 'bg-violet-600 text-white font-bold' : 'bg-gray-100 text-gray-600'}`}>
                    {w} {q.toLocaleString()}
                  </span>
                ))}
            </div>
          )}

          {/* 큰 버튼들 */}
          <div className="mt-5 grid grid-cols-2 gap-3">
            <button onClick={() => addQty(20)} disabled={saving}
              className={`py-8 bg-violet-600 text-white rounded-2xl ${sz('bigBtn')} font-bold hover:bg-violet-700 active:scale-95 disabled:opacity-50 transition shadow`}>
              + 20
            </button>
            <button onClick={undoLast}
              className={`py-8 bg-white border-2 border-rose-300 text-rose-600 rounded-2xl ${sz('subBtn')} font-bold hover:bg-rose-50 active:scale-95 transition`}>
              ↶ 직전 취소
            </button>
          </div>

          {/* 낱개 입력 */}
          <div className="mt-3 bg-slate-50 border rounded-lg p-3 flex items-center gap-2">
            <span className={`${sz('manualLabel')} text-gray-600`}>낱개</span>
            <input type="number" inputMode="numeric" value={manualQty || ''} onChange={(e) => setManualQty(Number(e.target.value) || 0)}
              className={`flex-1 border rounded px-3 py-2 text-center font-bold ${sz('manualInput')}`} placeholder="예: 6" />
            <button onClick={async () => { if (manualQty > 0) { await addQty(manualQty); setManualQty(0); } }}
              disabled={saving || manualQty <= 0}
              className="px-5 py-2 bg-emerald-600 text-white rounded font-bold hover:bg-emerald-700 disabled:bg-gray-300">
              + 추가
            </button>
          </div>

          {/* 내 합계 */}
          <div className={`mt-3 text-center ${sz('mine')} text-gray-600`}>
            내 합계 (<span className="font-bold text-violet-700">{worker}</span>): <span className="font-bold text-violet-700">{myCount.toLocaleString()}</span> 개
          </div>
        </div>
      )}

      {/* 품목 선택 모달 */}
      {showPicker && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-2xl h-[80vh] flex flex-col overflow-hidden">
            <div className="px-5 py-3 border-b flex items-center justify-between bg-violet-50">
              <h3 className="font-bold text-lg">품목 선택</h3>
              <button onClick={() => setShowPicker(false)} className="w-8 h-8 rounded-full hover:bg-gray-200 text-gray-500">×</button>
            </div>
            <div className="p-3 border-b space-y-2">
              <input value={search} onChange={(e) => setSearch(e.target.value)}
                placeholder="🔍 코드 또는 품목명…"
                className="w-full border rounded-lg px-4 py-3 text-lg" />
              {/* 단계 탭 */}
              <div className="flex flex-wrap gap-2">
                <button onClick={() => setStageFilter('')}
                  className={`px-4 py-2.5 rounded-lg ${sz('pickerTab')} font-bold active:scale-95 transition ${stageFilter === '' ? 'bg-violet-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>
                  전체
                </button>
                {presentStages.map((s) => (
                  <button key={s} onClick={() => setStageFilter(s)}
                    className={`px-4 py-2.5 rounded-lg ${sz('pickerTab')} font-bold active:scale-95 transition ${stageFilter === s ? 'bg-violet-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>
                    {s === 'F500' ? 'F-500' : s}
                  </button>
                ))}
              </div>
            </div>
            <div className="flex-1 overflow-y-auto">
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
                    // 현황판과 동일 색: 남음=빨강 / 완료=초록 / 초과=보라 (목표0=회색)
                    const remain = tg - done;
                    const started = done > 0;
                    const bar = tg <= 0 ? 'bg-gray-300' : remain > 0 ? 'bg-rose-500' : remain === 0 ? 'bg-emerald-500' : 'bg-violet-500';
                    const numCls = !started ? 'text-gray-500' : remain > 0 ? 'text-rose-600' : remain === 0 ? 'text-emerald-700' : 'text-violet-700';
                    return (
                      <li key={it.code}>
                        <button onClick={() => { setPicked(it.code); setShowPicker(false); setSearch(''); }}
                          className="w-full text-left px-4 py-4 hover:bg-violet-50 active:bg-violet-100 flex items-center gap-3">
                          <div className="flex-1 min-w-0">
                            <div className={`${sz('pickerCode')} font-bold text-violet-600 font-mono`}>{it.code}</div>
                            <div className={`${sz('pickerName')} font-semibold truncate`}>{it.name}</div>
                            <div className="mt-1.5 h-2 bg-gray-100 rounded-full overflow-hidden">
                              <div className={`h-full ${bar}`} style={{ width: `${pct}%` }} />
                            </div>
                          </div>
                          <div className="text-right whitespace-nowrap">
                            <div className={sz('pickerQty')}>
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
    </div>
  );
}

function WorkerSetup({ onSet }: { onSet: (w: string) => void }) {
  const [v, setV] = useState('');
  return (
    <div className="flex gap-2">
      <input value={v} onChange={(e) => setV(e.target.value)} placeholder="이름"
        className="flex-1 border rounded-lg px-4 py-3 text-lg" autoFocus
        onKeyDown={(e) => { if (e.key === 'Enter' && v.trim()) onSet(v.trim()); }} />
      <button onClick={() => v.trim() && onSet(v.trim())} disabled={!v.trim()}
        className="px-5 py-3 bg-violet-600 text-white rounded-lg font-bold disabled:bg-gray-300">
        시작
      </button>
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
