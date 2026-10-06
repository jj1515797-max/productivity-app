/** 입력 › 외포장 입력 — 태블릿 들고 다니는 사람용
 *  ① 냉각 종료 알림(누르면 출고) ② 입고 대기 카드(내포장 입력된 품목×채널) ③ 냉각실 도면 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { collection, deleteDoc, doc, setDoc, updateDoc } from 'firebase/firestore';
import { db } from '../firebase';
import {
  CART_COL, CHANNELS, CH_STYLE, cartMinutes, splitByDate, unlockAudio, chime, fmtLeft, hhmm, nextFreeSlot, slotLabel, useCoolingConfig,
} from '../lib/cooling';
import type { CartItem, Channel, CoolingCart, RoomConfig } from '../lib/cooling';
import { useActiveCarts, useDayCarts, usePendingCards } from '../lib/coolingData';
import type { PendingCard } from '../lib/coolingData';
import CoolingRoomMap from '../components/CoolingRoomMap';
import WorkDateNav, { useWorkDate } from '../components/WorkDateNav';
import { useSorted } from '../lib/packSort';

export default function CoolingInput() {
  const [date, setDate, today] = useWorkDate();
  const isToday = date === today;
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);

  const [cfg] = useCoolingConfig();
  const activeAll = useActiveCarts();
  // 대기(버퍼) 대차는 냉각실·타이머·알림과 무관 — 따로 뺀다
  const active = activeAll.filter((c) => !c.waiting);
  const waitingAll = activeAll.filter((c) => c.waiting);
  const dayCarts = useDayCarts(date);
  const sorted = useSorted(date);
  const { cards, loaded } = usePendingCards(date, dayCarts, sorted);

  const [sel, setSel] = useState<Set<string>>(new Set());
  const [chFilter, setChFilter] = useState<Channel | '전체'>('전체');
  // 외포장 1·2·3 — 여러 개 고를 수 있고, 아무것도 안 고르면 전체
  const [packFilter, setPackFilter] = useState<Set<number>>(() => {
    try { return new Set(JSON.parse(localStorage.getItem('coolPackFilter') || '[]')); } catch { return new Set(); }
  });
  const togglePack = (n: number) => setPackFilter((s) => {
    const x = new Set(s); if (x.has(n)) x.delete(n); else x.add(n);
    try { localStorage.setItem('coolPackFilter', JSON.stringify([...x])); } catch { /* 무시 */ }
    return x;
  });
  const [showIn, setShowIn] = useState(false);
  const [q, setQ] = useState('');                                    // 입고 대기 검색 (숫자만 쳐도 됨)
  const [waitOpen, setWaitOpen] = useState<CoolingCart | null>(null); // 대기 대차 열기
  const [detail, setDetail] = useState<CoolingCart | null>(null);
  const [moving, setMoving] = useState<CoolingCart | null>(null);
  const [toast, setToast] = useState<{ msg: string; undo?: () => void } | null>(null);
  const [sound, setSound] = useState(() => { try { return localStorage.getItem('coolSound') !== 'off'; } catch { return true; } });

  const selCards = cards.filter((c) => sel.has(c.key));
  const selChannel = selCards[0]?.channel;
  // 카드가 사라지면(다른 태블릿에서 입고 등) 선택도 정리
  useEffect(() => {
    const keys = new Set(cards.map((c) => c.key));
    setSel((s) => { const n = new Set([...s].filter((k) => keys.has(k))); return n.size === s.size ? s : n; });
  }, [cards]);

  const toggle = (c: PendingCard) => {
    chime('tap');
    setSel((s) => {
      const n = new Set(s);
      // 대차 1대 = 채널 1개 — 다른 채널을 누르면 그 채널로 새로 고른다
      if (selChannel && selChannel !== c.channel) return new Set([c.key]);
      if (n.has(c.key)) n.delete(c.key); else n.add(c.key);
      return n;
    });
  };

  /* ---------- 냉각 종료 알림 ---------- */
  // 보고 있는 날짜의 대차만 — 다른 날짜에 넣은 건 도면에 흐리게만, 알림·개수에서는 뺀다
  const { shown, ghosts } = splitByDate(active, date, today);
  const done = shown.filter((c) => now >= c.endAt);
  const notified = useRef<Set<string>>(new Set());
  useEffect(() => {
    const fresh = done.filter((c) => !notified.current.has(c.id));
    fresh.forEach((c) => notified.current.add(c.id));
    if (fresh.length && sound) chime('done');
  }, [done.map((c) => c.id).join(','), sound]); // eslint-disable-line react-hooks/exhaustive-deps
  // 종료된 대차가 남아 있으면 출고할 때까지 3초마다 계속 울림 (「5분 조용히」 로 잠시 멈춤)
  const [snoozeUntil, setSnoozeUntil] = useState(0);
  const snoozed = now < snoozeUntil;
  useEffect(() => {
    if (!sound || snoozed || done.length === 0) return;
    const ring = () => {
      chime('done');
      try { navigator.vibrate?.([300, 150, 300]); } catch { /* 무시 */ }
    };
    const t = setInterval(ring, 3000);
    return () => clearInterval(t);
  }, [sound, snoozed, done.length]);
  // 아무 데나 한 번 누르면 소리를 깨워 둔다 + 화면 꺼짐 방지 (지원 기기만)
  useEffect(() => {
    window.addEventListener('pointerdown', unlockAudio);
    let lock: any = null;
    const req = async () => { try { lock = await (navigator as any).wakeLock?.request('screen'); } catch { /* 무시 */ } };
    req();
    const onVis = () => { if (document.visibilityState === 'visible') req(); };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      window.removeEventListener('pointerdown', unlockAudio);
      document.removeEventListener('visibilitychange', onVis);
      try { lock?.release(); } catch { /* 무시 */ }
    };
  }, []);

  // 쓰기는 기다리지 않는다 — 화면은 바로 반영되고(오프라인이어도), 서버 저장 실패만 따로 알린다.
  // 기다리면 현장 와이파이가 약할 때 버튼이 멈춘 것처럼 보인다.
  const fire = (p: Promise<unknown>, what: string) => {
    p.catch((e) => showToast(`⚠ ${what} 저장 실패 — 인터넷 연결을 확인하고 다시 해 주세요 (${e?.message || e})`));
  };
  const [ask, setAsk] = useState<{ title: string; msg: string; ok: string; danger?: boolean; onOk: () => void } | null>(null);
  const showToast = (msg: string, undo?: () => void) => {
    setToast({ msg, undo });
    window.setTimeout(() => setToast((t) => (t && t.msg === msg ? null : t)), 10_000);
  };

  const release = (c: CoolingCart) => {
    fire(updateDoc(doc(db, CART_COL, c.id), { out: true, outAt: Date.now() }), '출고');
    setDetail(null);
    showToast(`${c.cartNo}번 대차 출고 (${c.channel} · ${c.items.map((i) => i.code).join(', ')})`, () => {
      unrelease(c, true);
      setToast(null);
    });
  };

  /** 출고 취소 — 냉각실로 되돌린다. 원래 자리에 다른 대차가 들어왔으면 다음 빈자리로.
   *  확인은 브라우저 confirm() 대신 화면 안 확인창 — 태블릿(홈 화면 앱 등)에서는 confirm 이 막혀 버튼이 안 먹는다. */
  const unrelease = (c: CoolingCart, quiet = false) => {
    if (quiet) { doUnrelease(c, true); return; }
    const dup = active.find((x) => x.id !== c.id && x.cartNo === c.cartNo);
    setAsk({
      title: `${c.cartNo}번 대차 출고 취소`,
      msg: `${c.channel} · ${c.items.map((i) => i.code).join(', ')}\n냉각실로 되돌릴까요?`
        + (dup ? `\n\n⚠ ${c.cartNo}번 대차가 지금 냉각실 ${dup.room}에도 있습니다.` : ''),
      ok: '출고 취소',
      onOk: () => doUnrelease(c),
    });
  };
  const doUnrelease = (c: CoolingCart, quiet = false) => {
    const room = cfg.rooms.find((r) => r.id === c.room);
    const others = active.filter((x) => x.id !== c.id);
    const taken = others.some((x) => x.room === c.room && x.slot === c.slot);
    const slot = !taken ? c.slot : room ? nextFreeSlot(room, others) : -1;
    fire(updateDoc(doc(db, CART_COL, c.id), { out: false, outAt: null, slot }), '출고 취소');
    if (!quiet && room) showToast(`${c.cartNo}번 대차 출고 취소 → ${room.name} ${slotLabel(room, slot)}`);
  };

  /* ---------- 자리 이동 ---------- */
  const moveTo = async (room: RoomConfig, slot: number) => {
    if (!moving) return;
    const other = active.find((c) => c.room === room.id && c.slot === slot && c.id !== moving.id);
    const from = { room: moving.room, slot: moving.slot };
    fire(updateDoc(doc(db, CART_COL, moving.id), { room: room.id, slot }), '자리 이동');
    if (other) fire(updateDoc(doc(db, CART_COL, other.id), from), '자리 이동');   // 자리 맞바꾸기
    setMoving(null);
  };

  const byPack = packFilter.size === 0 ? cards : cards.filter((c) => c.packs.some((p) => packFilter.has(p)));
  const byCh = chFilter === '전체' ? byPack : byPack.filter((c) => c.channel === chFilter);
  // 검색: 숫자만 → 코드 번호가 같은 것 (63 → E63, F63). 없으면 그 숫자로 시작하는 것. 글자가 섞이면 코드·이름 포함
  const filtered = (() => {
    const t = q.trim().toLowerCase();
    if (!t) return byCh;
    if (/^\d+$/.test(t)) {
      const num = (code: string) => (code.match(/\d+/g) || []).join('').replace(/^0+/, '');
      const want = t.replace(/^0+/, '');
      const exact = byCh.filter((c) => num(c.code) === want);
      return exact.length ? exact : byCh.filter((c) => num(c.code).startsWith(want));
    }
    return byCh.filter((c) => c.code.toLowerCase().includes(t) || c.name.toLowerCase().includes(t));
  })();
  const { shown: waiting } = splitByDate(waitingAll, date, today);
  const roomOf = (id: number) => cfg.rooms.find((r) => r.id === id);

  return (
    <div className="space-y-4 pb-24">
      <div className="flex items-center gap-3 flex-wrap">
        <h2 className="text-xl font-bold">외포장 입력</h2>
        <WorkDateNav date={date} setDate={(d) => { setSel(new Set()); setDate(d); }} today={today} />
        <span className="text-xs text-gray-500">대기 {waiting.length}대 · 냉각 중 {shown.length - done.length}대 · 종료 {done.length}대</span>
        <button onClick={() => { const n = !sound; setSound(n); try { localStorage.setItem('coolSound', n ? 'on' : 'off'); } catch { /* 무시 */ } if (n) chime('tap'); }}
          className="ml-auto px-3 py-1.5 text-sm border rounded bg-white">{sound ? '🔔 알림음 켬' : '🔕 알림음 끔'}</button>
        <span className="text-3xl font-mono font-bold text-gray-800 tabular-nums">{hhmm(now)}</span>
      </div>

      {!isToday && (
        <div className="border border-orange-300 bg-orange-50 text-orange-800 rounded-lg px-4 py-2 text-sm">
          <b>{date}</b> 에 넣은 대차만 보고 있습니다 (입고 대기·냉각실·알림·출고 기록 모두). 다른 날짜에 넣고 아직 안 뺀 대차는 도면에 회색 「다른 날」로 자리만 표시됩니다.
        </div>
      )}

      {/* ① 냉각 종료 — 누르면 출고 */}
      {done.length > 0 && (
        <section className="space-y-2">
          <div className="flex items-center gap-3">
            <div className="text-sm font-bold text-rose-700">🔔 냉각 종료 — 카드를 누르면 출고됩니다</div>
            {sound && (snoozed
              ? <button onClick={() => setSnoozeUntil(0)} className="ml-auto px-3 py-1.5 text-sm rounded border border-rose-300 text-rose-700 bg-white">🔕 {fmtLeft(snoozeUntil - now)} 뒤 다시 울림 · 지금 켜기</button>
              : <button onClick={() => setSnoozeUntil(Date.now() + 5 * 60_000)} className="ml-auto px-3 py-1.5 text-sm rounded bg-rose-600 text-white font-bold">🔕 5분 조용히</button>)}
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {done.map((c) => {
              const room = roomOf(c.room);
              return (
                <button key={c.id} onClick={() => release(c)}
                  className="text-left rounded-xl border-4 border-rose-500 bg-rose-50 p-4 animate-pulse active:scale-[0.98]">
                  <div className="flex items-center gap-2">
                    <span className="text-3xl font-extrabold text-gray-900">{c.cartNo}번</span>
                    <span className={`px-2 py-0.5 rounded text-white text-sm font-bold ${CH_STYLE[c.channel].bg}`}>{c.channel}</span>
                    <span className="ml-auto text-xs text-rose-700 font-bold">{fmtLeft(now - c.endAt)} 지남</span>
                  </div>
                  <div className="mt-1 text-lg font-bold text-rose-800">{room?.name || `냉각실 ${c.room}`} · {room ? slotLabel(room, c.slot) : ''}</div>
                  <div className="mt-1 text-sm text-gray-700">{c.items.map((i) => `${i.code} ${i.name} ${i.qty}`).join(' / ')}</div>
                  <div className="mt-2 text-center text-white bg-rose-600 rounded-lg py-2 font-bold">눌러서 출고</div>
                </button>
              );
            })}
          </div>
        </section>
      )}

      {/* ② 입고 대기 */}
      <section className="bg-white border rounded-xl">
        <div className="px-4 py-2.5 border-b flex items-center gap-2 flex-wrap">
          <span className="font-bold text-gray-800">입고 대기</span>
          <span className="text-xs text-gray-500">외포장에서 「분류 완료」 한 품목 · 같은 채널끼리 여러 개 골라 한 대차로 입고</span>
          <div className="ml-auto flex gap-1 items-center">
            {[1, 2, 3].map((n) => (
              <button key={n} onClick={() => togglePack(n)}
                className={`px-3 py-1 text-xs rounded-full border-2 font-bold ${packFilter.has(n) ? 'bg-indigo-600 text-white border-indigo-600' : 'bg-white border-indigo-200 text-indigo-700'}`}>
                외포장 {n}
              </button>
            ))}
            <span className="w-px h-5 bg-gray-300 mx-1" />
            {(['전체', ...CHANNELS] as const).map((ch) => (
              <button key={ch} onClick={() => setChFilter(ch)}
                className={`px-2.5 py-1 text-xs rounded-full border ${chFilter === ch ? 'bg-gray-900 text-white border-gray-900' : 'bg-white'}`}>
                {ch}{ch !== '전체' && ` ${byPack.filter((c) => c.channel === ch).length}`}
              </button>
            ))}
          </div>
        </div>
        <div className="px-3 pt-3 flex items-center gap-2 flex-wrap">
          <div className="relative">
            <input value={q} onChange={(e) => setQ(e.target.value)} inputMode="search" enterKeyHint="search"
              placeholder="🔍 번호만 쳐도 됨 (63 → E63, F63)"
              className="w-72 max-w-full border-2 border-gray-300 focus:border-blue-500 rounded-lg pl-3 pr-9 py-2 text-base" />
            {q && <button onClick={() => setQ('')} aria-label="검색 지우기"
              className="absolute right-1.5 top-1/2 -translate-y-1/2 w-7 h-7 rounded-full bg-gray-200 text-gray-600 font-bold">✕</button>}
          </div>
          {q && <span className="text-sm text-gray-500">{filtered.length}개</span>}
          {/* 채널을 골라 둔 상태면 보이는 카드를 한 번에 고를 수 있다 */}
          {chFilter !== '전체' && filtered.length > 0 && (
            <button onClick={() => { chime('tap'); setSel(new Set(filtered.map((c) => c.key))); }}
              className="ml-auto px-3 py-2 rounded-lg border-2 border-blue-500 text-blue-700 font-bold">
              보이는 {chFilter} {filtered.length}개 모두 선택
            </button>
          )}
        </div>
        {/* 카드가 많아도 아래 냉각실 도면이 바로 보이게 — 목록 안에서만 스크롤 */}
        <div className="p-3 max-h-[45vh] overflow-y-auto overscroll-contain">
          {!loaded ? <div className="text-center text-gray-400 py-8">불러오는 중…</div>
            : filtered.length === 0 ? <div className="text-center text-gray-400 py-8">{cards.length === 0 ? '입고할 품목이 없습니다 — 외포장-1·2·3 화면에서 품목 행을 눌러 「분류 완료」 하면 여기에 뜹니다' : q ? `「${q}」 에 맞는 품목이 없습니다` : '고른 필터에 맞는 품목이 없습니다'}</div>
              : (
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2">
                  {filtered.map((c) => {
                    const st = CH_STYLE[c.channel];
                    const on = sel.has(c.key);
                    const dim = !!selChannel && selChannel !== c.channel;
                    return (
                      <button key={c.key} onClick={() => toggle(c)}
                        className={`relative text-left rounded-lg border-2 p-2.5 transition active:scale-[0.97]
                          ${on ? `${st.border} ${st.soft} ring-4 ring-blue-400` : 'border-gray-200 bg-white'} ${dim ? 'opacity-40' : ''}`}>
                        <span className={`absolute right-2 top-2 px-1.5 py-0.5 rounded text-[11px] font-bold text-white ${st.bg}`}>{c.channel}</span>
                        <div className="font-mono font-extrabold text-xl text-gray-900">{c.code}</div>
                        <div className="text-sm text-gray-700 truncate pr-2">{c.name}</div>
                        <div className="mt-1 text-2xl font-extrabold tabular-nums">{c.remain.toLocaleString()}<span className="text-xs font-normal text-gray-500 ml-1">개</span></div>
                        <div className="text-[11px] text-gray-500">
                          <b className="text-indigo-700 mr-1">외포장{c.packs.join('·')}</b>
                          {c.lastAt && <b className="text-gray-700 mr-1">{c.lastAt}</b>}
                          {c.inQty > 0 && `이미 ${c.inQty} 입고 · `}
                          생산 {c.produced.toLocaleString()}/{c.target.toLocaleString()}
                          {c.produced < c.target && <span className="text-rose-600 font-bold"> 생산 중</span>}
                        </div>
                        {on && <span className="absolute left-2 top-2 text-blue-600 text-lg">✔</span>}
                      </button>
                    );
                  })}
                </div>
              )}
        </div>
      </section>

      {/* ③ 대기 (버퍼) — 대차에 실어 두기만 한 것. 눌러서 품목을 더 싣거나 냉각실로 보낸다 */}
      {waiting.length > 0 && (
        <section className="bg-amber-50 border-2 border-amber-300 rounded-xl p-3 space-y-2">
          <div className="font-bold text-amber-900">⏸ 대기 중 대차 {waiting.length}대 <span className="text-xs font-normal text-amber-800">— 눌러서 품목 추가 · 냉각실로 넣기 (넣는 순간 타이머 시작)</span></div>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2">
            {waiting.map((c) => (
              <button key={c.id} onClick={() => { chime('tap'); setWaitOpen(c); }}
                className={`text-left rounded-xl border-2 ${CH_STYLE[c.channel].border} bg-white p-3 active:scale-[0.97]`}>
                <div className="flex items-center gap-2">
                  <span className="text-2xl font-extrabold">{c.cartNo}번</span>
                  <span className={`px-2 py-0.5 rounded text-white text-xs font-bold ${CH_STYLE[c.channel].bg}`}>{c.channel}</span>
                </div>
                <div className="text-sm text-gray-700 mt-1 line-clamp-2">{c.items.map((i) => i.code).join(', ')}</div>
                <div className="text-xs text-gray-500 mt-0.5">{c.items.length}품목 · {c.items.reduce((s2, i) => s2 + i.qty, 0)}개{c.waitAt ? ` · ${hhmm(c.waitAt)}부터 대기` : ''}</div>
              </button>
            ))}
          </div>
        </section>
      )}

      {/* ④ 냉각실 도면 */}
      {moving && (
        <div className="sticky top-14 z-30 bg-blue-600 text-white rounded-lg px-4 py-3 flex items-center gap-3 shadow-lg">
          <span className="font-bold">{moving.cartNo}번 대차 이동 — 옮길 칸을 누르세요</span>
          <span className="text-xs opacity-80">(대차가 있는 칸을 누르면 자리를 맞바꿉니다)</span>
          <button onClick={() => setMoving(null)} className="ml-auto px-3 py-1 bg-white/20 rounded">취소</button>
        </div>
      )}
      {/* 냉각 입출고 현황판과 같게 — 태블릿 가로·PC 에서는 냉각실 3개를 한 줄에, 세로로 들면 위아래로 */}
      <div className="grid grid-cols-1 md:landscape:grid-cols-3 xl:grid-cols-3 gap-3">
        {cfg.rooms.map((room) => (
          <CoolingRoomMap key={room.id} room={room} now={now}
            carts={shown.filter((c) => c.room === room.id)}
            ghosts={ghosts.filter((c) => c.room === room.id)}
            moving={moving}
            onTapCart={(c) => setDetail(c)}
            onLongPressCart={(c) => { chime('tap'); setMoving(c); }}
            onTapSlot={(slot) => moveTo(room, slot)} />
        ))}
      </div>
      <div className="text-xs text-gray-500">칸을 <b>꾹 누르면</b> 자리 이동 · 칸을 누르면 상세(출고·입고 취소)</div>

      {/* 오늘 출고한 대차 — 잘못 출고했으면 여기서 되돌린다 */}
      {(() => {
        const outs = dayCarts.filter((c) => c.out).sort((a, b) => (b.outAt || 0) - (a.outAt || 0));
        if (outs.length === 0) return null;
        return (
          <details className="bg-white border rounded-xl">
            <summary className="px-4 py-3 cursor-pointer font-bold text-gray-800">
              {isToday ? '오늘' : date} 출고한 대차 {outs.length}대 <span className="text-xs font-normal text-gray-500">— 잘못 출고했으면 눌러서 「출고 취소」</span>
            </summary>
            <div className="divide-y">
              {outs.map((c) => (
                <div key={c.id} className="px-4 py-2.5 flex items-center gap-3 flex-wrap">
                  <span className="text-sm text-gray-500 tabular-nums w-20">{c.outAt ? hhmm(c.outAt) : ''} 출고</span>
                  <span className="text-xl font-extrabold w-14">{c.cartNo}번</span>
                  <span className={`px-2 py-0.5 rounded text-white text-xs font-bold ${CH_STYLE[c.channel].bg}`}>{c.channel}</span>
                  <span className="text-sm text-gray-600">{roomOf(c.room)?.name}</span>
                  <span className="text-sm flex-1 min-w-[200px]">{c.items.map((i) => `${i.code} ${i.name} ${i.qty}`).join(' / ')}</span>
                  <button onClick={() => unrelease(c)}
                    className="px-4 py-2 rounded-lg border-2 border-blue-500 text-blue-700 font-bold active:bg-blue-50">↩ 출고 취소</button>
                </div>
              ))}
            </div>
          </details>
        );
      })()}

      {/* 하단 고정 — 선택한 카드 입고 */}
      {selCards.length > 0 && (
        <div className="fixed bottom-0 inset-x-0 z-40 bg-white border-t shadow-2xl px-4 py-3 flex items-center gap-3">
          <span className={`px-2 py-1 rounded text-white font-bold ${CH_STYLE[selChannel!].bg}`}>{selChannel}</span>
          <span className="font-bold">{selCards.length}개 품목 선택</span>
          <span className="text-sm text-gray-600 truncate">{selCards.map((c) => c.code).join(', ')}</span>
          <button onClick={() => setSel(new Set())} className="ml-auto px-3 py-2 border rounded">선택 해제</button>
          <button onClick={() => setShowIn(true)} className="px-6 py-3 bg-blue-600 text-white rounded-lg text-lg font-bold">대차에 실어 입고 →</button>
        </div>
      )}

      {showIn && selChannel && (
        <InboundModal cards={selCards} channel={selChannel} rooms={cfg.rooms} active={active} waiting={waitingAll}
          minutes={cartMinutes(cfg, selCards.map((c) => c.code))}
          onClose={() => setShowIn(false)}
          onSubmit={async (cartNo, room) => {
            if (room === 0) {
              // 대기 — 냉각실·타이머 없이 대차 내용만 저장
              const ref = doc(collection(db, CART_COL));
              fire(setDoc(ref, {
                date, cartNo, room: 0, slot: -1, channel: selChannel,
                items: selCards.map((c) => ({ code: c.code, name: c.name, qty: c.remain })),
                startAt: 0, endAt: 0, durationMin: 0, out: false, waiting: true, waitAt: Date.now(),
              }), '대기');
              setShowIn(false); setSel(new Set());
              showToast(`${cartNo}번 대차 → 대기 (냉각실에 넣을 때 타이머 시작)`, () => { fire(deleteDoc(ref), '대기 되돌리기'); setToast(null); });
              return;
            }
            const r = cfg.rooms.find((x) => x.id === room)!;
            const min = cartMinutes(cfg, selCards.map((c) => c.code));
            const start = Date.now();
            const slot = nextFreeSlot(r, active);
            const ref = doc(collection(db, CART_COL));
            fire(setDoc(ref, {
              date, cartNo, room, slot, channel: selChannel,
              items: selCards.map((c) => ({ code: c.code, name: c.name, qty: c.remain })),
              startAt: start, endAt: start + min * 60_000, durationMin: min, out: false,
            }), '입고');
            setShowIn(false); setSel(new Set());
            showToast(`${cartNo}번 대차 → ${r.name} ${slotLabel(r, slot)} · ${min}분 후 종료 (${hhmm(start + min * 60_000)})`,
              () => { fire(deleteDoc(ref), '입고 되돌리기'); setToast(null); });
          }} />
      )}

      {waitOpen && (() => {
        const cart = waitingAll.find((c) => c.id === waitOpen.id);
        if (!cart) return null;
        return (
          <WaitingModal cart={cart} cards={cards.filter((c) => c.channel === cart.channel)} rooms={cfg.rooms} active={active}
            minutesOf={(codes) => cartMinutes(cfg, codes)}
            onClose={() => setWaitOpen(null)}
            onSave={(items) => { fire(updateDoc(doc(db, CART_COL, cart.id), { items }), '대기 품목 추가'); setWaitOpen(null); showToast(`${cart.cartNo}번 대차 품목 저장 (대기 유지)`); }}
            onDelete={() => setAsk({
              title: `${cart.cartNo}번 대차 대기 취소`,
              msg: '대기 대차 기록을 지웁니다.\n실은 품목은 다시 입고 대기로 돌아갑니다.',
              ok: '대기 취소', danger: true,
              onOk: () => { fire(deleteDoc(doc(db, CART_COL, cart.id)), '대기 취소'); setWaitOpen(null); },
            })}
            onDispatch={(items, roomId) => {
              const r = cfg.rooms.find((x) => x.id === roomId)!;
              const min = cartMinutes(cfg, items.map((i) => i.code));
              const start = Date.now();
              const slot = nextFreeSlot(r, active);
              fire(updateDoc(doc(db, CART_COL, cart.id), {
                items, room: roomId, slot, waiting: false, startAt: start, endAt: start + min * 60_000, durationMin: min,
              }), '냉각실 입고');
              setWaitOpen(null);
              showToast(`${cart.cartNo}번 대차 대기 → ${r.name} ${slotLabel(r, slot)} · ${min}분 후 종료 (${hhmm(start + min * 60_000)})`);
            }} />
        );
      })()}

      {detail && (
        <CartDetail cart={active.find((c) => c.id === detail.id) || detail} room={roomOf(detail.room)} now={now}
          onClose={() => setDetail(null)}
          onRelease={() => {
            const c = active.find((x) => x.id === detail.id) || detail;
            if (now >= c.endAt) { release(c); return; }
            setAsk({ title: `${c.cartNo}번 대차 출고`, msg: `아직 냉각 중입니다 (${fmtLeft(c.endAt - now)} 남음).\n그래도 출고할까요?`, ok: '출고', danger: true, onOk: () => release(c) });
          }}
          onMove={() => { setMoving(detail); setDetail(null); }}
          onCancel={() => setAsk({
            title: `${detail.cartNo}번 대차 입고 취소`,
            msg: '잘못 입고한 경우에 씁니다.\n대차 기록이 지워지고 품목이 다시 입고 대기로 돌아갑니다.',
            ok: '입고 취소', danger: true,
            onOk: () => { fire(deleteDoc(doc(db, CART_COL, detail.id)), '입고 취소'); setDetail(null); },
          })} />
      )}

      {ask && (
        <div className="fixed inset-0 z-[60] bg-black/50 flex items-center justify-center p-4" onClick={() => setAsk(null)}>
          <div className="bg-white rounded-2xl p-5 w-full max-w-sm space-y-4" onClick={(e) => e.stopPropagation()}>
            <div className="text-lg font-bold">{ask.title}</div>
            <div className="text-gray-700 whitespace-pre-line">{ask.msg}</div>
            <div className="grid grid-cols-2 gap-2">
              <button onClick={() => setAsk(null)} className="py-3 rounded-lg border text-lg">아니요</button>
              <button onClick={() => { const f = ask.onOk; setAsk(null); f(); }}
                className={`py-3 rounded-lg text-white text-lg font-bold ${ask.danger ? 'bg-rose-600' : 'bg-blue-600'}`}>{ask.ok}</button>
            </div>
          </div>
        </div>
      )}

      {toast && (
        <div className="fixed bottom-24 left-1/2 -translate-x-1/2 z-50 bg-gray-900 text-white rounded-lg px-4 py-3 shadow-xl flex items-center gap-3 max-w-[92vw]">
          <span className="text-sm">{toast.msg}</span>
          {toast.undo && <button onClick={toast.undo} className="px-3 py-1 bg-white/20 rounded font-bold text-amber-300 whitespace-nowrap">되돌리기</button>}
        </div>
      )}
    </div>
  );
}

/** 태블릿용 창 틀 — 화면 가운데 고정 높이. 내용이 길면 안에서만 스크롤하고, 아래 버튼 줄은 항상 보인다.
 *  (전에는 아래에서 올라오는 창이라 내용이 늘면 위로 커지고, 길면 버튼이 화면 밖으로 밀려 못 눌렀다) */
function Shell({ head, children, foot, onClose, wide }: {
  head: React.ReactNode; children: React.ReactNode; foot: React.ReactNode; onClose: () => void; wide?: boolean;
}) {
  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-2 sm:p-4" onClick={onClose}>
      <div className={`bg-white w-full ${wide ? 'max-w-4xl' : 'max-w-lg'} rounded-2xl flex flex-col max-h-[94dvh] overflow-hidden`}
        onClick={(e) => e.stopPropagation()}>
        <div className="px-4 py-3 border-b flex items-center gap-2 shrink-0">
          {head}
          <button onClick={onClose} aria-label="닫기" className="ml-auto w-11 h-11 rounded-full text-2xl text-gray-500 active:bg-gray-100 shrink-0">✕</button>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain p-4">{children}</div>
        <div className="px-4 py-3 border-t bg-gray-50 shrink-0">{foot}</div>
      </div>
    </div>
  );
}

/** 대차 번호 키패드 — 숫자 칸은 높이 고정이라 숫자를 눌러도 화면이 들썩이지 않는다 */
function CartNoPad({ no, setNo, warn }: { no: string; setNo: (f: (v: string) => string) => void; warn?: string }) {
  const key = (k: string) => {
    chime('tap');
    if (k === '←') setNo((v) => v.slice(0, -1));
    else if (k === 'C') setNo(() => '');
    else setNo((v) => (v + k).slice(0, 4));
  };
  return (
    <div>
      <div className="text-sm font-bold text-gray-700 mb-1">① 대차 번호</div>
      <div className={`h-20 flex items-center justify-center text-5xl leading-none font-extrabold tabular-nums border-2 rounded-xl ${warn ? 'border-rose-500 text-rose-600 bg-rose-50' : 'border-gray-300'}`}>
        {no || <span className="text-gray-300 text-3xl">번호를 누르세요</span>}
      </div>
      {/* 경고 자리를 늘 비워 둔다 — 경고가 생겼다 사라질 때 아래 버튼이 움직이지 않게 */}
      <div className="h-10 text-sm text-rose-600 font-bold leading-tight pt-1 overflow-hidden">{warn || ''}</div>
      <div className="grid grid-cols-3 gap-2">
        {['1', '2', '3', '4', '5', '6', '7', '8', '9', 'C', '0', '←'].map((k) => (
          <button key={k} onClick={() => key(k)}
            className={`h-14 text-2xl font-bold rounded-xl select-none active:bg-gray-300 ${k === 'C' || k === '←' ? 'bg-gray-200 text-gray-700' : 'bg-gray-100'}`}>{k}</button>
        ))}
      </div>
    </div>
  );
}

/** 냉각실 1·2·3 + 대기 — 같은 크기 버튼 4개 */
function RoomPick({ rooms, active, room, setRoom, allowWait }: {
  rooms: RoomConfig[]; active: CoolingCart[]; room: number | null; setRoom: (r: number) => void; allowWait: boolean;
}) {
  const free = Object.fromEntries(rooms.map((r) => [r.id, r.rows * r.cols - active.filter((c) => c.room === r.id && c.slot >= 0).length]));
  return (
    <div>
      <div className="text-sm font-bold text-gray-700 mb-1">② 어디로</div>
      <div className={`grid ${allowWait ? 'grid-cols-2' : 'grid-cols-3'} gap-2`}>
        {rooms.map((r) => (
          <button key={r.id} onClick={() => { chime('tap'); setRoom(r.id); }}
            className={`h-20 rounded-xl border-2 font-bold ${room === r.id ? 'border-blue-600 bg-blue-600 text-white' : 'border-gray-300 bg-white'}`}>
            <div className="text-lg">{r.name}</div>
            <div className={`text-xs ${room === r.id ? 'text-blue-100' : free[r.id] <= 0 ? 'text-rose-600' : 'text-gray-500'}`}>빈칸 {Math.max(0, free[r.id])}</div>
          </button>
        ))}
        {allowWait && (
          <button onClick={() => { chime('tap'); setRoom(0); }}
            className={`h-20 rounded-xl border-2 font-bold ${room === 0 ? 'border-amber-500 bg-amber-500 text-white' : 'border-amber-300 bg-amber-50 text-amber-900'}`}>
            <div className="text-lg">⏸ 대기</div>
            <div className={`text-xs ${room === 0 ? 'text-amber-100' : 'text-amber-700'}`}>타이머 없이 담아 두기</div>
          </button>
        )}
      </div>
      <div className="h-5 text-xs text-amber-700 mt-1">{room !== null && room > 0 && free[room] <= 0 ? '빈칸이 없어 「자리 미지정」으로 들어갑니다.' : ''}</div>
    </div>
  );
}

function ItemList({ items, title }: { items: { code: string; name: string; qty: number }[]; title: string }) {
  return (
    <div>
      <div className="text-sm font-bold text-gray-700 mb-1">{title} <span className="font-normal text-gray-500">{items.length}품목 · {items.reduce((s2, i) => s2 + i.qty, 0)}개</span></div>
      <div className="border rounded-lg divide-y max-h-48 overflow-y-auto overscroll-contain">
        {items.map((i) => (
          <div key={i.code} className="px-3 py-1.5 flex items-center gap-2 text-sm">
            <b className="font-mono w-14">{i.code}</b><span className="flex-1 truncate">{i.name}</span><b className="tabular-nums">{i.qty}</b>
          </div>
        ))}
      </div>
    </div>
  );
}

function InboundModal({ cards, channel, rooms, active, waiting, minutes, onClose, onSubmit }: {
  cards: PendingCard[]; channel: Channel; rooms: RoomConfig[]; active: CoolingCart[]; waiting: CoolingCart[]; minutes: number;
  onClose: () => void; onSubmit: (cartNo: string, room: number) => Promise<void>;
}) {
  const [no, setNo] = useState('');
  const [room, setRoom] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const inUse = no ? [...active, ...waiting].find((c) => c.cartNo === no) : undefined;
  const warn = inUse ? `⚠ ${no}번은 이미 ${inUse.waiting ? '대기' : `냉각실 ${inUse.room}`}에 있습니다 (${inUse.channel}). 번호를 확인하세요.` : '';
  return (
    <Shell wide onClose={onClose}
      head={<>
        <span className={`px-2 py-1 rounded text-white font-bold ${CH_STYLE[channel].bg}`}>{channel}</span>
        <span className="font-bold text-lg">대차 입고</span>
        <span className="text-sm text-gray-500">냉각 {minutes}분</span>
      </>}
      foot={
        <button disabled={!no || room === null || !!inUse || busy}
          onClick={async () => { setBusy(true); try { await onSubmit(no, room!); } catch { setBusy(false); } }}
          className={`w-full h-16 rounded-xl text-white text-xl font-bold disabled:bg-gray-300 ${room === 0 ? 'bg-amber-500' : 'bg-blue-600'}`}>
          {busy ? '저장 중…' : !no ? '대차 번호를 누르세요' : room === null ? '냉각실 또는 대기를 고르세요'
            : room === 0 ? `${no}번 대차 → 대기에 넣기` : `${no}번 대차 → ${rooms.find((r) => r.id === room)?.name} 입고 · 냉각 시작`}
        </button>
      }>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <CartNoPad no={no} setNo={setNo} warn={warn} />
        <div className="space-y-3">
          <ItemList title="실을 품목" items={cards.map((c) => ({ code: c.code, name: c.name, qty: c.remain }))} />
          <RoomPick rooms={rooms} active={active} room={room} setRoom={setRoom} allowWait />
        </div>
      </div>
    </Shell>
  );
}

/** 대기 대차 — 같은 채널 품목을 더 싣고, 냉각실로 보낸다(그때 타이머 시작) */
function WaitingModal({ cart, cards, rooms, active, minutesOf, onClose, onSave, onDelete, onDispatch }: {
  cart: CoolingCart; cards: PendingCard[]; rooms: RoomConfig[]; active: CoolingCart[];
  minutesOf: (codes: string[]) => number;
  onClose: () => void; onSave: (items: CartItem[]) => void; onDelete: () => void; onDispatch: (items: CartItem[], room: number) => void;
}) {
  const [add, setAdd] = useState<Set<string>>(new Set());
  const [room, setRoom] = useState<number | null>(null);
  const [q, setQ] = useState('');
  const merged = useMemo(() => {
    const m = new Map<string, CartItem>(cart.items.map((i) => [i.code, { ...i }]));
    cards.filter((c) => add.has(c.key)).forEach((c) => {
      const e = m.get(c.code);
      if (e) e.qty += c.remain; else m.set(c.code, { code: c.code, name: c.name, qty: c.remain });
    });
    return [...m.values()];
  }, [cart.items, cards, add]);
  const t = q.trim().toLowerCase();
  const num = (code: string) => (code.match(/\d+/g) || []).join('').replace(/^0+/, '');
  const list = !t ? cards : /^\d+$/.test(t) ? cards.filter((c) => num(c.code).startsWith(t.replace(/^0+/, '')))
    : cards.filter((c) => c.code.toLowerCase().includes(t) || c.name.toLowerCase().includes(t));
  const min = minutesOf(merged.map((i) => i.code));
  return (
    <Shell wide onClose={onClose}
      head={<>
        <span className="text-2xl font-extrabold">{cart.cartNo}번</span>
        <span className={`px-2 py-1 rounded text-white font-bold ${CH_STYLE[cart.channel].bg}`}>{cart.channel}</span>
        <span className="text-sm text-amber-700 font-bold">⏸ 대기 중</span>
        <span className="text-sm text-gray-500">냉각 {min}분</span>
      </>}
      foot={
        <div className="grid grid-cols-3 gap-2">
          <button onClick={onDelete} className="h-16 rounded-xl border-2 border-rose-300 text-rose-600 font-bold">대기 취소</button>
          <button onClick={() => onSave(merged)} disabled={add.size === 0}
            className="h-16 rounded-xl border-2 border-amber-400 text-amber-800 font-bold disabled:opacity-40">품목만 추가<br /><span className="text-xs font-normal">(대기 유지)</span></button>
          <button onClick={() => room && onDispatch(merged, room)} disabled={!room}
            className="h-16 rounded-xl bg-blue-600 text-white text-lg font-bold disabled:bg-gray-300">
            {room ? `${rooms.find((r) => r.id === room)?.name} 입고 · 냉각 시작` : '냉각실을 고르세요'}
          </button>
        </div>
      }>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="space-y-3">
          <ItemList title="대차에 실린 품목" items={merged} />
          <RoomPick rooms={rooms} active={active} room={room} setRoom={(r) => setRoom(r)} allowWait={false} />
        </div>
        <div>
          <div className="text-sm font-bold text-gray-700 mb-1">＋ 같이 실을 {cart.channel} 품목 <span className="font-normal text-gray-500">(눌러서 추가)</span></div>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="🔍 번호·이름" className="w-full border-2 rounded-lg px-3 py-2 mb-2" />
          <div className="max-h-[42dvh] overflow-y-auto overscroll-contain space-y-1.5">
            {list.length === 0 && <div className="text-sm text-gray-400 py-4 text-center">추가할 {cart.channel} 품목이 없습니다</div>}
            {list.map((c) => {
              const on = add.has(c.key);
              return (
                <button key={c.key} onClick={() => { chime('tap'); setAdd((s) => { const n = new Set(s); if (n.has(c.key)) n.delete(c.key); else n.add(c.key); return n; }); }}
                  className={`w-full h-14 px-3 rounded-lg border-2 flex items-center gap-2 text-left ${on ? 'border-blue-500 bg-blue-50' : 'border-gray-200 bg-white'}`}>
                  <span className={`w-6 h-6 rounded border-2 flex items-center justify-center shrink-0 ${on ? 'bg-blue-600 border-blue-600 text-white' : 'border-gray-400'}`}>{on ? '✔' : ''}</span>
                  <b className="font-mono w-14 shrink-0">{c.code}</b>
                  <span className="flex-1 truncate">{c.name}</span>
                  <b className="tabular-nums">{c.remain}</b>
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </Shell>
  );
}

function CartDetail({ cart, room, now, onClose, onRelease, onMove, onCancel }: {
  cart: CoolingCart; room?: RoomConfig; now: number;
  onClose: () => void; onRelease: () => void; onMove: () => void; onCancel: () => void;
}) {
  const left = cart.endAt - now;
  return (
    <Shell onClose={onClose}
      head={<>
        <span className="text-3xl font-extrabold">{cart.cartNo}번</span>
        <span className={`px-2 py-1 rounded text-white font-bold ${CH_STYLE[cart.channel].bg}`}>{cart.channel}</span>
      </>}
      foot={
        <div className="grid grid-cols-3 gap-2">
          <button onClick={onCancel} className="h-14 rounded-xl border-2 border-rose-300 text-rose-600 font-bold">입고 취소</button>
          <button onClick={onMove} className="h-14 rounded-xl border-2 font-bold">자리 이동</button>
          <button onClick={onRelease} className={`h-14 rounded-xl font-bold text-white text-lg ${left <= 0 ? 'bg-rose-600' : 'bg-gray-500'}`}>출고</button>
        </div>
      }>
      <div className="space-y-3">
        <div className="text-gray-700">{room?.name || `냉각실 ${cart.room}`} · {room ? slotLabel(room, cart.slot) : ''}</div>
        <div className={`text-2xl font-bold ${left <= 0 ? 'text-rose-600' : ''}`}>
          {left <= 0 ? `냉각 종료 (${fmtLeft(-left)} 지남)` : `남은 시간 ${fmtLeft(left)}`}
          <div className="text-sm font-normal text-gray-500">{hhmm(cart.startAt)} 입고 → {hhmm(cart.endAt)} 종료 ({cart.durationMin}분)</div>
        </div>
        {/* 품목이 많아도(아침에 몰아 넣을 때) 이 안에서만 스크롤 — 아래 출고 버튼은 항상 보인다 */}
        <ItemList title="실린 품목" items={cart.items} />
      </div>
    </Shell>
  );
}
