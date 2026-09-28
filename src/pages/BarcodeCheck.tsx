/** 입력 › 바코드 확인
 *
 *  바코드 리더기(키보드 방식)로 찍기만 하면 제품명·제품코드가 바로 뜬다. 화면 터치·조작 불필요.
 *  - 입력창에 포커스가 없어도 창 전체에서 키 입력을 받는다 (리더기 = 아주 빠른 키보드 + Enter)
 *  - Enter/Tab 이 오거나, 입력이 잠깐(150ms) 멈추면 한 번 찍은 것으로 본다
 *  - DB 에 없거나 체크디지트가 틀리면 「바코드 불량」
 *  - 가상 키보드가 튀어나오지 않게 화면의 입력창은 읽기 전용(표시용)이다
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { addDoc, collection, deleteDoc, doc, limit, onSnapshot, orderBy, query, writeBatch } from 'firebase/firestore';
import { db } from '../firebase';
import { BARCODE_COL, barcodeVariants, gtinCheck, normalizeBarcode } from '../lib/barcode';
import type { ProductBarcode } from '../lib/barcode';
import { effectiveTodayKey, shiftDateKey } from '../lib/dateUtil';

type Result =
  | { ok: true; raw: string; hit: ProductBarcode; at: number; seq: number; id?: string }
  | { ok: false; raw: string; reason: string; at: number; seq: number; id?: string };

/** 스캔 기록 — Firestore `barcodeScans/{YYYY-MM-DD}/logs/{자동ID}`
 *  날짜는 입력 화면과 같은 기준(새벽 2시 전은 전날 — 야간조) */
interface ScanDoc {
  at: number; raw: string; ok: boolean;
  code?: string; name?: string; barcode?: string; reason?: string;
}
const scanCol = (date: string) => collection(db, 'barcodeScans', date, 'logs');
function toResult(id: string, d: ScanDoc): Result {
  return d.ok
    ? { ok: true, raw: d.raw, hit: { barcode: d.barcode || d.raw, code: d.code || '', name: d.name || '' }, at: d.at, seq: d.at, id }
    : { ok: false, raw: d.raw, reason: d.reason || '', at: d.at, seq: d.at, id };
}

const IDLE_MS = 150;       // 리더기는 글자 사이가 수 ms — 이만큼 멈추면 끝난 것으로 본다
const MIN_LEN = 4;         // 이보다 짧으면 잡음(키 한두 개 눌림)으로 보고 무시

/* ---------- 소리 — 성공 '띡', 불량 '삐-삐' ---------- */
let audioCtx: AudioContext | null = null;
function beep(ok: boolean) {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
    const ctx = audioCtx!;
    if (ctx.state === 'suspended') ctx.resume();
    const tone = (freq: number, start: number, dur: number) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = ok ? 'sine' : 'square';
      o.frequency.value = freq;
      g.gain.setValueAtTime(0.0001, ctx.currentTime + start);
      g.gain.exponentialRampToValueAtTime(0.35, ctx.currentTime + start + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + start + dur);
      o.connect(g).connect(ctx.destination);
      o.start(ctx.currentTime + start);
      o.stop(ctx.currentTime + start + dur + 0.02);
    };
    if (ok) tone(1760, 0, 0.12);
    else { tone(330, 0, 0.18); tone(330, 0.25, 0.18); }
  } catch { /* 소리 실패는 무시 */ }
}

/** IME(한글 모드)일 때 e.key 가 'Process' 로 오는 경우 물리 키로 복원 */
function keyChar(e: KeyboardEvent): string | null {
  if (e.key.length === 1) return e.key;
  if (e.key === 'Process' || e.key === 'Unidentified') {
    const m = /^(Digit|Numpad)(\d)$/.exec(e.code);
    if (m) return m[2];
    const k = /^Key([A-Z])$/.exec(e.code);
    if (k) return k[1];
    if (e.code === 'Minus') return '-';
  }
  return null;
}

export default function BarcodeCheck() {
  const [map, setMap] = useState<Map<string, ProductBarcode> | null>(null);
  const [typing, setTyping] = useState('');
  const [cur, setCur] = useState<Result | null>(null);
  const [history, setHistory] = useState<Result[]>([]);
  const [viewDate, setViewDate] = useState(effectiveTodayKey());
  const [histLoaded, setHistLoaded] = useState(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const [manual, setManual] = useState(false);
  const [manualText, setManualText] = useState('');
  const [sound, setSound] = useState(() => {
    try { return localStorage.getItem('barcodeSound') !== 'off'; } catch { return true; }
  });
  const bufRef = useRef('');
  const timerRef = useRef<number | null>(null);
  const seqRef = useRef(0);
  const mapRef = useRef<Map<string, ProductBarcode> | null>(null);
  const scanInputRef = useRef<HTMLInputElement | null>(null);
  const manualRef = useRef(false);
  manualRef.current = manual;
  const soundRef = useRef(sound);
  soundRef.current = sound;

  useEffect(() => onSnapshot(collection(db, BARCODE_COL), (snap) => {
    const m = new Map<string, ProductBarcode>();
    snap.forEach((d) => m.set(d.id, { ...(d.data() as ProductBarcode), barcode: d.id }));
    mapRef.current = m;
    setMap(m);
  }), []);

  // 그 날짜의 스캔 기록 — 다른 화면에 갔다 와도, 다른 기기에서 찍어도 그대로 보인다
  useEffect(() => {
    setHistLoaded(false);
    return onSnapshot(query(scanCol(viewDate), orderBy('at', 'desc'), limit(3000)), (snap) => {
      const list: Result[] = [];
      snap.forEach((d) => list.push(toResult(d.id, d.data() as ScanDoc)));
      setHistory(list);
      setHistLoaded(true);
    }, (e) => { console.error('[BarcodeCheck]', e); setHistLoaded(true); });
  }, [viewDate]);

  // 화면 꺼짐 방지 (지원 기기만)
  useEffect(() => {
    let lock: any = null;
    const req = async () => {
      try { lock = await (navigator as any).wakeLock?.request('screen'); } catch { /* 무시 */ }
    };
    req();
    const onVis = () => { if (document.visibilityState === 'visible') req(); };
    document.addEventListener('visibilitychange', onVis);
    return () => { document.removeEventListener('visibilitychange', onVis); try { lock?.release(); } catch { /* 무시 */ } };
  }, []);

  const handleScan = useCallback((rawIn: string) => {
    const raw = normalizeBarcode(rawIn);
    if (raw.length < MIN_LEN) return;
    const m = mapRef.current;
    const seq = ++seqRef.current;
    const at = Date.now();
    let res: Result;
    const hitKey = m ? barcodeVariants(raw).find((v) => m.has(v)) : undefined;
    if (hitKey && m) {
      res = { ok: true, raw, hit: m.get(hitKey)!, at, seq };
    } else {
      const ck = gtinCheck(raw);
      const reason = !m ? '바코드 DB 를 아직 못 불러왔습니다'
        : ck === false ? '인식 오류 — 체크디지트 불일치 (인쇄 불량·긁힘 가능)'
          : !/^[0-9A-Z\-.]+$/.test(raw) ? '인식 오류 — 바코드에 올 수 없는 문자'
            : '등록되지 않은 바코드';
      res = { ok: false, raw, reason, at, seq };
    }
    if (soundRef.current) beep(res.ok);
    setCur(res);
    // 찍는 순간의 날짜로 저장하고, 지난 날짜를 보고 있었으면 오늘로 돌아온다
    const day = effectiveTodayKey();
    setViewDate(day);
    const docData: ScanDoc = res.ok
      ? { at, raw, ok: true, code: res.hit.code, name: res.hit.name, barcode: res.hit.barcode }
      : { at, raw, ok: false, reason: res.reason };
    addDoc(scanCol(day), docData)
      .then(() => setSaveErr(null))
      .catch((e) => setSaveErr(e?.message || String(e)));
  }, []);

  // 들어오자마자 스캔창에 포커스 — 안 그러면 방금 누른 탭 링크에 포커스가 남아
  // 기기에 따라 리더기 입력이 페이지로 안 들어온다 (입력창을 한 번 눌러야 되던 문제).
  // 다른 곳을 눌러 포커스가 빠져도 곧바로 되돌린다. 직접 입력 중일 때만 예외.
  useEffect(() => {
    const grab = () => {
      if (manualRef.current) return;
      const a = document.activeElement as HTMLElement | null;
      if (a && a !== scanInputRef.current && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT')) return;
      if (a !== scanInputRef.current) scanInputRef.current?.focus({ preventScroll: true });
    };
    const later = () => window.setTimeout(grab, 0);
    const t1 = window.setTimeout(grab, 50);
    const t2 = window.setTimeout(grab, 400);
    const iv = window.setInterval(grab, 1500);
    window.addEventListener('focus', later);
    document.addEventListener('visibilitychange', later);
    document.addEventListener('pointerup', later, true);
    document.addEventListener('focusout', later, true);
    return () => {
      window.clearTimeout(t1); window.clearTimeout(t2); window.clearInterval(iv);
      window.removeEventListener('focus', later);
      document.removeEventListener('visibilitychange', later);
      document.removeEventListener('pointerup', later, true);
      document.removeEventListener('focusout', later, true);
    };
  }, []);

  const flush = useCallback(() => {
    if (timerRef.current) { window.clearTimeout(timerRef.current); timerRef.current = null; }
    const v = bufRef.current;
    bufRef.current = '';
    setTyping('');
    if (v) handleScan(v);
  }, [handleScan]);

  // 창 전체 키 입력 — 포커스 위치와 무관하게 받는다
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      // 수동 입력창·다른 입력칸에 치는 중이면 그쪽에 맡긴다
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable) && !t.dataset.scanDisplay) return;
      if (e.ctrlKey || e.altKey || e.metaKey) return;
      if (e.key === 'Enter' || e.key === 'Tab') {
        // 버튼에 포커스가 남아 있으면 리더기의 Enter 가 그 버튼을 눌러 버린다 → 막는다
        if (bufRef.current || t?.tagName === 'BUTTON') e.preventDefault();
        if (bufRef.current) flush();
        return;
      }
      const ch = keyChar(e);
      if (!ch) return;
      e.preventDefault();
      bufRef.current += ch;
      setTyping(bufRef.current);
      if (timerRef.current) window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(flush, IDLE_MS);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [flush]);

  const okCount = history.filter((h) => h.ok).length;
  const badCount = history.length - okCount;
  // 같은 바코드를 연달아 찍은 횟수 — 같은 화면이 그대로여도 새로 찍힌 걸 알 수 있게
  const today = effectiveTodayKey();
  const isToday = viewDate === today;
  // 다른 화면에 갔다 와도 마지막으로 찍은 것이 그대로 보이게 — 오늘 기록의 맨 위
  const shown: Result | null = cur ?? (isToday ? history[0] ?? null : null);
  const streak = (() => {
    if (!shown) return 0;
    let n = 0;
    for (const h of history) { if (h.raw === shown.raw) n++; else break; }
    return n;
  })();
  // 품목별 집계 (정상만) — 많이 찍힌 순
  const byProduct = (() => {
    const m = new Map<string, { code: string; name: string; n: number }>();
    history.forEach((h) => {
      if (!h.ok) return;
      const e = m.get(h.hit.code);
      if (e) e.n++; else m.set(h.hit.code, { code: h.hit.code, name: h.hit.name, n: 1 });
    });
    return [...m.values()].sort((a, b) => b.n - a.n || a.code.localeCompare(b.code));
  })();
  const removeOne = async (h: Result) => {
    if (!h.id) return;
    const what = h.ok ? `${h.hit.code} ${h.hit.name}` : `불량 (${h.raw})`;
    if (!confirm(`${time(h.at)} ${what}\n이 기록을 삭제할까요?`)) return;
    try {
      await deleteDoc(doc(db, 'barcodeScans', viewDate, 'logs', h.id));
      if (cur && cur.at === h.at && cur.raw === h.raw) setCur(null);
    } catch (e: any) { alert(`삭제 실패: ${e?.message || e}`); }
  };
  const removeAll = async () => {
    if (history.length === 0) return;
    if (prompt(`⚠️ ${viewDate} 기록 ${history.length}건을 모두 삭제합니다. 되돌릴 수 없습니다.\n진행하려면 "삭제" 를 입력하세요.`) !== '삭제') return;
    try {
      const ids = history.map((h) => h.id).filter((x): x is string => !!x);
      for (let i = 0; i < ids.length; i += 400) {
        const b = writeBatch(db);
        ids.slice(i, i + 400).forEach((id) => b.delete(doc(db, 'barcodeScans', viewDate, 'logs', id)));
        await b.commit();
      }
      setCur(null);
    } catch (e: any) { alert(`삭제 실패: ${e?.message || e}`); }
  };

  const downloadXlsx = async () => {
    const ExcelJS = (await import('exceljs')).default;
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet(`${viewDate} 스캔기록`);
    ws.columns = [
      { header: '시간', key: 't', width: 10 }, { header: '결과', key: 'r', width: 8 },
      { header: '읽힌 바코드', key: 'b', width: 18 }, { header: '제품코드', key: 'c', width: 12 },
      { header: '제품명', key: 'n', width: 30 }, { header: '불량 사유', key: 'why', width: 40 },
    ];
    [...history].reverse().forEach((h) => ws.addRow({
      t: time(h.at), r: h.ok ? '정상' : '불량', b: h.raw,
      c: h.ok ? h.hit.code : '', n: h.ok ? h.hit.name : '', why: h.ok ? '' : h.reason,
    }));
    ws.getRow(1).font = { bold: true };
    ws.views = [{ state: 'frozen', ySplit: 1 }];
    const ws2 = wb.addWorksheet('품목별 집계');
    ws2.columns = [{ header: '제품코드', key: 'c', width: 12 }, { header: '제품명', key: 'n', width: 30 }, { header: '정상 스캔 수', key: 'k', width: 12 }];
    byProduct.forEach((p) => ws2.addRow({ c: p.code, n: p.name, k: p.n }));
    ws2.addRow({ n: '불량', k: badCount });
    ws2.getRow(1).font = { bold: true };
    const buf = await wb.xlsx.writeBuffer();
    const url = URL.createObjectURL(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
    const a = document.createElement('a');
    a.href = url; a.download = `바코드확인_${viewDate}.xlsx`; a.click();
    URL.revokeObjectURL(url);
  };
  const time = (t: number) => {
    const d = new Date(t);
    const p2 = (n: number) => String(n).padStart(2, '0');
    return `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
  };

  return (
    <div className="max-w-5xl mx-auto p-3 sm:p-5 space-y-4 select-none">
      <div className="flex items-center gap-3 flex-wrap">
        <h1 className="text-xl font-bold text-gray-800">바코드 확인</h1>
        <span className={`text-xs px-2 py-0.5 rounded-full ${map ? 'bg-emerald-100 text-emerald-700' : 'bg-gray-100 text-gray-500'}`}>
          {map ? `DB ${map.size.toLocaleString()}개` : 'DB 불러오는 중…'}
        </span>
        <div className="flex items-center gap-1 text-sm">
          <button onClick={() => { setCur(null); setViewDate(shiftDateKey(viewDate, -1)); }} className="px-2 py-0.5 border rounded bg-white hover:bg-gray-50">◀</button>
          <span className={`px-2 font-mono font-bold ${isToday ? 'text-blue-700' : 'text-amber-700'}`}>{viewDate}{isToday && ' (오늘)'}</span>
          <button onClick={() => { setCur(null); setViewDate(shiftDateKey(viewDate, 1)); }} disabled={isToday} className="px-2 py-0.5 border rounded bg-white hover:bg-gray-50 disabled:opacity-30">▶</button>
          {!isToday && <button onClick={() => setViewDate(today)} className="ml-1 px-2 py-0.5 text-xs border rounded bg-blue-600 text-white">오늘로</button>}
        </div>
        <span className="text-xs text-gray-500">{histLoaded ? '' : '기록 불러오는 중… '}정상 <b className="text-emerald-700">{okCount}</b> · 불량 <b className="text-rose-600">{badCount}</b></span>
        <div className="ml-auto flex items-center gap-2">
          <button onClick={() => { const n = !sound; setSound(n); try { localStorage.setItem('barcodeSound', n ? 'on' : 'off'); } catch { /* 무시 */ } }}
            className="px-2.5 py-1 text-xs border rounded bg-white hover:bg-gray-50">{sound ? '🔊 소리 켬' : '🔇 소리 끔'}</button>
          <button onClick={downloadXlsx} disabled={history.length === 0}
            className="px-2.5 py-1 text-xs border rounded bg-white hover:bg-gray-50 disabled:opacity-40">📥 엑셀</button>
        </div>
      </div>

      {/* 스캔 표시줄 — 읽기 전용 (가상 키보드 안 뜨게) */}
      <div className="flex items-center gap-2">
        <input ref={scanInputRef} data-scan-display="1" readOnly inputMode="none" autoFocus
          value={typing || (shown ? shown.raw : '')}
          placeholder="바코드를 찍으세요 — 화면을 누를 필요 없습니다"
          className={`flex-1 border-2 rounded-lg px-4 py-3 font-mono text-2xl tracking-wider bg-white
            ${typing ? 'border-blue-500' : 'border-gray-300'} text-gray-800 placeholder:text-gray-400 placeholder:text-base placeholder:font-sans placeholder:tracking-normal`} />
        <button onClick={() => setManual(!manual)} className="px-3 py-3 text-xs border rounded-lg bg-white hover:bg-gray-50 whitespace-nowrap">
          {manual ? '닫기' : '⌨ 직접 입력'}
        </button>
      </div>
      {manual && (
        <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); handleScan(manualText); setManualText(''); }}>
          <input autoFocus value={manualText} onChange={(e) => setManualText(e.target.value)} inputMode="numeric"
            placeholder="바코드 번호를 직접 입력 후 Enter" className="flex-1 border rounded px-3 py-2 font-mono" />
          <button className="px-4 py-2 bg-blue-600 text-white rounded text-sm">확인</button>
        </form>
      )}

      {/* 결과 */}
      {!shown ? (
        <div className="border-2 border-dashed rounded-2xl py-20 text-center text-gray-400">
          <div className="text-5xl mb-3">▮▯▮▮▯▮</div>
          <div className="text-lg">바코드를 찍으면 여기에 제품이 뜹니다</div>
        </div>
      ) : shown.ok ? (
        <div key={shown.seq} className="rounded-2xl bg-emerald-600 text-white px-6 py-10 text-center shadow-lg animate-[scanflash_0.35s_ease-out]">
          <div className="text-sm opacity-80 mb-2">✔ 정상 {streak > 1 && <span className="ml-1 bg-white/20 rounded px-1.5">같은 바코드 {streak}번째</span>}</div>
          <div className="text-4xl sm:text-6xl font-extrabold leading-tight break-keep">{shown.hit.name || '(제품명 없음)'}</div>
          <div className="mt-4 text-3xl sm:text-4xl font-mono font-bold">{shown.hit.code}</div>
          <div className="mt-3 text-sm font-mono opacity-80">{shown.raw}{shown.raw !== shown.hit.barcode && ` (등록: ${shown.hit.barcode})`} · {time(shown.at)}</div>
        </div>
      ) : (
        <div key={shown.seq} className="rounded-2xl bg-rose-600 text-white px-6 py-10 text-center shadow-lg animate-[scanflash_0.35s_ease-out]">
          <div className="text-sm opacity-80 mb-2">✖ {streak > 1 && <span className="bg-white/20 rounded px-1.5">같은 바코드 {streak}번째</span>}</div>
          <div className="text-5xl sm:text-7xl font-extrabold">바코드 불량</div>
          <div className="mt-4 text-lg sm:text-xl font-semibold">{shown.reason}</div>
          <div className="mt-3 text-sm font-mono opacity-80">읽힌 값: {shown.raw} · {time(shown.at)}</div>
        </div>
      )}

      {saveErr && (
        <div className="border border-rose-300 bg-rose-50 text-rose-700 rounded px-3 py-2 text-xs">⚠ 기록 저장 실패 — {saveErr}. 인터넷 연결을 확인하세요 (화면 표시는 정상).</div>
      )}

      {/* 품목별 집계 */}
      {byProduct.length > 0 && (
        <div className="bg-white border rounded-lg overflow-hidden">
          <div className="px-4 py-2 border-b bg-slate-50 text-sm font-bold text-gray-700">품목별 집계 <span className="text-xs font-normal text-gray-500">{viewDate} · 정상 스캔 수</span></div>
          <div className="flex flex-wrap gap-2 p-3">
            {byProduct.map((p) => (
              <span key={p.code} className="inline-flex items-center gap-1.5 border rounded-full px-3 py-1 text-sm">
                <b className="font-mono text-indigo-700">{p.code}</b>
                <span className="text-gray-700">{p.name}</span>
                <b className="text-emerald-700 tabular-nums">{p.n}</b>
              </span>
            ))}
            {badCount > 0 && <span className="inline-flex items-center gap-1.5 border border-rose-200 bg-rose-50 rounded-full px-3 py-1 text-sm text-rose-700">불량 <b>{badCount}</b></span>}
          </div>
        </div>
      )}

      {/* 최근 기록 */}
      {history.length > 0 && (
        <div className="bg-white border rounded-lg overflow-hidden">
          <div className="px-4 py-2 border-b bg-slate-50 text-sm font-bold text-gray-700 flex items-center gap-2">
            <span>{viewDate} 기록 <span className="text-xs font-normal text-gray-500">{history.length.toLocaleString()}건 · 자동 저장 (다른 기기에서도 같이 보임)</span></span>
            <button onClick={removeAll} className="ml-auto text-xs font-normal text-red-500 hover:underline">🗑 이 날짜 전체 삭제</button>
          </div>
          <div className="max-h-80 overflow-y-auto">
            <table className="w-full text-sm">
              <tbody className="divide-y">
                {history.map((h) => (
                  <tr key={h.id || h.seq} className={h.ok ? '' : 'bg-rose-50'}>
                    <td className="px-3 py-1.5 text-xs text-gray-500 w-20 tabular-nums">{time(h.at)}</td>
                    <td className="px-3 py-1.5 w-16">{h.ok ? <span className="text-emerald-700 font-bold">정상</span> : <span className="text-rose-600 font-bold">불량</span>}</td>
                    <td className="px-3 py-1.5 font-mono text-xs text-gray-600 w-40">{h.raw}</td>
                    <td className="px-3 py-1.5">{h.ok ? <><b className="font-mono text-indigo-700 mr-2">{h.hit.code}</b>{h.hit.name}</> : <span className="text-rose-600 text-xs">{h.reason}</span>}</td>
                    <td className="px-2 py-1 w-16 text-right">
                      {h.id && <button onClick={() => removeOne(h)} title="이 기록 삭제"
                        className="px-2.5 py-1 text-xs text-red-500 border border-red-200 rounded hover:bg-red-50 active:bg-red-100">삭제</button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <style>{'@keyframes scanflash{0%{transform:scale(.96);opacity:.4}100%{transform:scale(1);opacity:1}}'}</style>
    </div>
  );
}
