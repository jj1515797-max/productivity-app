/** 입력 › 바코드 확인
 *
 *  바코드 리더기(키보드 방식)로 찍기만 하면 제품명·제품코드가 바로 뜬다. 화면 터치·조작 불필요.
 *  - 입력창에 포커스가 없어도 창 전체에서 키 입력을 받는다 (리더기 = 아주 빠른 키보드 + Enter)
 *  - Enter/Tab 이 오거나, 입력이 잠깐(150ms) 멈추면 한 번 찍은 것으로 본다
 *  - DB 에 없거나 체크디지트가 틀리면 「바코드 불량」
 *  - 가상 키보드가 튀어나오지 않게 화면의 입력창은 읽기 전용(표시용)이다
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { collection, onSnapshot } from 'firebase/firestore';
import { db } from '../firebase';
import { BARCODE_COL, barcodeVariants, gtinCheck, normalizeBarcode } from '../lib/barcode';
import type { ProductBarcode } from '../lib/barcode';

type Result =
  | { ok: true; raw: string; hit: ProductBarcode; at: number; seq: number }
  | { ok: false; raw: string; reason: string; at: number; seq: number };

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
    setHistory((h) => [res, ...h].slice(0, 50));
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
  const streak = (() => {
    if (!cur) return 0;
    let n = 0;
    for (const h of history) { if (h.raw === cur.raw) n++; else break; }
    return n;
  })();
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
        <span className="text-xs text-gray-500">정상 <b className="text-emerald-700">{okCount}</b> · 불량 <b className="text-rose-600">{badCount}</b></span>
        <div className="ml-auto flex items-center gap-2">
          <button onClick={() => { const n = !sound; setSound(n); try { localStorage.setItem('barcodeSound', n ? 'on' : 'off'); } catch { /* 무시 */ } }}
            className="px-2.5 py-1 text-xs border rounded bg-white hover:bg-gray-50">{sound ? '🔊 소리 켬' : '🔇 소리 끔'}</button>
          <button onClick={() => { setHistory([]); setCur(null); }}
            className="px-2.5 py-1 text-xs border rounded bg-white hover:bg-gray-50">기록 지우기</button>
        </div>
      </div>

      {/* 스캔 표시줄 — 읽기 전용 (가상 키보드 안 뜨게) */}
      <div className="flex items-center gap-2">
        <input ref={scanInputRef} data-scan-display="1" readOnly inputMode="none" autoFocus
          value={typing || (cur ? cur.raw : '')}
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
      {!cur ? (
        <div className="border-2 border-dashed rounded-2xl py-20 text-center text-gray-400">
          <div className="text-5xl mb-3">▮▯▮▮▯▮</div>
          <div className="text-lg">바코드를 찍으면 여기에 제품이 뜹니다</div>
        </div>
      ) : cur.ok ? (
        <div key={cur.seq} className="rounded-2xl bg-emerald-600 text-white px-6 py-10 text-center shadow-lg animate-[scanflash_0.35s_ease-out]">
          <div className="text-sm opacity-80 mb-2">✔ 정상 {streak > 1 && <span className="ml-1 bg-white/20 rounded px-1.5">같은 바코드 {streak}번째</span>}</div>
          <div className="text-4xl sm:text-6xl font-extrabold leading-tight break-keep">{cur.hit.name || '(제품명 없음)'}</div>
          <div className="mt-4 text-3xl sm:text-4xl font-mono font-bold">{cur.hit.code}</div>
          <div className="mt-3 text-sm font-mono opacity-80">{cur.raw}{cur.raw !== cur.hit.barcode && ` (등록: ${cur.hit.barcode})`} · {time(cur.at)}</div>
        </div>
      ) : (
        <div key={cur.seq} className="rounded-2xl bg-rose-600 text-white px-6 py-10 text-center shadow-lg animate-[scanflash_0.35s_ease-out]">
          <div className="text-sm opacity-80 mb-2">✖ {streak > 1 && <span className="bg-white/20 rounded px-1.5">같은 바코드 {streak}번째</span>}</div>
          <div className="text-5xl sm:text-7xl font-extrabold">바코드 불량</div>
          <div className="mt-4 text-lg sm:text-xl font-semibold">{cur.reason}</div>
          <div className="mt-3 text-sm font-mono opacity-80">읽힌 값: {cur.raw} · {time(cur.at)}</div>
        </div>
      )}

      {/* 최근 기록 */}
      {history.length > 0 && (
        <div className="bg-white border rounded-lg overflow-hidden">
          <div className="px-4 py-2 border-b bg-slate-50 text-sm font-bold text-gray-700">최근 찍은 기록 <span className="text-xs font-normal text-gray-500">(최근 50건 · 이 화면에서만)</span></div>
          <div className="max-h-80 overflow-y-auto">
            <table className="w-full text-sm">
              <tbody className="divide-y">
                {history.map((h) => (
                  <tr key={h.seq} className={h.ok ? '' : 'bg-rose-50'}>
                    <td className="px-3 py-1.5 text-xs text-gray-500 w-20 tabular-nums">{time(h.at)}</td>
                    <td className="px-3 py-1.5 w-16">{h.ok ? <span className="text-emerald-700 font-bold">정상</span> : <span className="text-rose-600 font-bold">불량</span>}</td>
                    <td className="px-3 py-1.5 font-mono text-xs text-gray-600 w-40">{h.raw}</td>
                    <td className="px-3 py-1.5">{h.ok ? <><b className="font-mono text-indigo-700 mr-2">{h.hit.code}</b>{h.hit.name}</> : <span className="text-rose-600 text-xs">{h.reason}</span>}</td>
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
