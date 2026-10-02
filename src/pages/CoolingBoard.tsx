/** 입력 › 냉각 입출고 — 물류팀·외부 인원용 실시간 현황판 (보기 전용)
 *  냉각실별 도면 + 종료 임박 순 목록 + 오늘 출고 기록 + 설정(도면 크기·단계별 냉각 시간) */
import { useEffect, useState } from 'react';
import { CH_STYLE, DEFAULT_CONFIG, fmtLeft, hhmm, slotLabel, splitByDate, useCoolingConfig } from '../lib/cooling';
import type { CoolingCart, CoolingConfig } from '../lib/cooling';
import { useActiveCarts, useDayCarts } from '../lib/coolingData';
import CoolingRoomMap from '../components/CoolingRoomMap';
import WorkDateNav, { useWorkDate } from '../components/WorkDateNav';

export default function CoolingBoard() {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  const [date, setDate, today] = useWorkDate();
  const isToday = date === today;
  const [cfg, saveCfg] = useCoolingConfig();
  const active = useActiveCarts();
  const day = useDayCarts(date);
  const outToday = day.filter((c) => c.out).sort((a, b) => (b.outAt || 0) - (a.outAt || 0));
  const [detail, setDetail] = useState<CoolingCart | null>(null);
  const [showCfg, setShowCfg] = useState(false);
  const roomOf = (id: number) => cfg.rooms.find((r) => r.id === id);
  const { shown, ghosts } = splitByDate(active, date, today);
  const doneCnt = shown.filter((c) => now >= c.endAt).length;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 flex-wrap">
        <h2 className="text-xl font-bold">냉각 입출고 현황</h2>
        <WorkDateNav date={date} setDate={setDate} today={today} />
        <span className="text-sm text-gray-600">냉각 중 <b>{shown.length - doneCnt}</b>대 · <span className="text-rose-600">종료(출고 대기) <b>{doneCnt}</b>대</span> · {isToday ? '오늘' : date.slice(5)} 입고 <b>{day.length}</b>대 · 출고 <b>{outToday.length}</b>대</span>
        <button onClick={() => setShowCfg(!showCfg)} className="ml-auto px-3 py-1.5 text-sm border rounded bg-white">⚙ 설정</button>
        <span className="text-3xl font-mono font-bold text-gray-800 tabular-nums">{hhmm(now)}</span>
      </div>

      {showCfg && <ConfigPanel cfg={cfg} onSave={async (c) => { await saveCfg(c); setShowCfg(false); }} />}

      <div className="grid grid-cols-1 md:landscape:grid-cols-3 xl:grid-cols-3 gap-3">
        {cfg.rooms.map((room) => (
          <CoolingRoomMap key={room.id} room={room} now={now} carts={shown.filter((c) => c.room === room.id)} ghosts={ghosts.filter((c) => c.room === room.id)} onTapCart={setDetail} />
        ))}
      </div>

      {/* 종료 임박 순 목록 */}
      <div className="bg-white border rounded-xl overflow-hidden">
        <div className="px-4 py-2 border-b bg-slate-50 font-bold text-sm text-gray-700">냉각실에 있는 대차 <span className="font-normal text-gray-500">— 끝나는 순</span></div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-xs text-gray-500 bg-gray-50">
              <tr>
                <th className="px-3 py-2 text-left">상태</th><th className="px-3 py-2 text-left">냉각실 · 자리</th>
                <th className="px-3 py-2 text-left">대차</th><th className="px-3 py-2 text-left">채널</th>
                <th className="px-3 py-2 text-left">품목</th><th className="px-3 py-2 text-right">입고</th><th className="px-3 py-2 text-right">종료</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {shown.length === 0 && <tr><td colSpan={7} className="px-3 py-8 text-center text-gray-400">냉각실에 대차가 없습니다</td></tr>}
              {shown.map((c) => {
                const left = c.endAt - now;
                const room = roomOf(c.room);
                return (
                  <tr key={c.id} className={left <= 0 ? 'bg-rose-50' : ''}>
                    <td className={`px-3 py-2 font-bold tabular-nums ${left <= 0 ? 'text-rose-600' : 'text-gray-800'}`}>{left <= 0 ? '종료 · 출고 대기' : `${fmtLeft(left)} 남음`}</td>
                    <td className="px-3 py-2">{room?.name || c.room} · {room ? slotLabel(room, c.slot) : ''}</td>
                    <td className="px-3 py-2 font-extrabold text-lg">{c.cartNo}</td>
                    <td className="px-3 py-2"><span className={`px-2 py-0.5 rounded text-white text-xs font-bold ${CH_STYLE[c.channel].bg}`}>{c.channel}</span></td>
                    <td className="px-3 py-2">{c.items.map((i) => <span key={i.code} className="mr-2"><b className="font-mono">{i.code}</b> {i.name} <span className="text-gray-500">{i.qty}</span></span>)}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-gray-500">{hhmm(c.startAt)}</td>
                    <td className="px-3 py-2 text-right tabular-nums font-bold">{hhmm(c.endAt)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* 그 날짜의 입출고 기록 — 날짜를 바꿔 지난 기록도 본다 */}
      {(() => {
        const rec = [...day].sort((a, b) => b.startAt - a.startAt);
        return (
          <details className="bg-white border rounded-xl" open={!isToday || undefined}>
            <summary className="px-4 py-2 cursor-pointer text-sm font-bold text-gray-700">
              {isToday ? '오늘' : date} 입출고 기록 {rec.length}대 <span className="font-normal text-gray-500">(입고 {rec.length} · 출고 {outToday.length})</span>
            </summary>
            {rec.length === 0 ? <div className="px-4 py-6 text-center text-gray-400 text-sm">이 날짜에 입고한 대차가 없습니다</div> : (
              <table className="w-full text-sm">
                <thead className="text-xs text-gray-500 bg-gray-50">
                  <tr><th className="px-3 py-1.5 text-left">입고</th><th className="px-3 py-1.5 text-left">출고</th><th className="px-3 py-1.5 text-left">냉각실</th><th className="px-3 py-1.5 text-left">대차</th><th className="px-3 py-1.5 text-left">채널</th><th className="px-3 py-1.5 text-left">품목</th></tr>
                </thead>
                <tbody className="divide-y">
                  {rec.map((c) => (
                    <tr key={c.id}>
                      <td className="px-3 py-1.5 tabular-nums">{hhmm(c.startAt)}</td>
                      <td className="px-3 py-1.5 tabular-nums">{c.out ? (c.outAt ? hhmm(c.outAt) : '출고') : <span className="text-blue-600 font-medium">냉각실에 있음</span>}</td>
                      <td className="px-3 py-1.5">{roomOf(c.room)?.name}</td>
                      <td className="px-3 py-1.5 font-bold">{c.cartNo}번</td>
                      <td className="px-3 py-1.5"><span className={`px-2 py-0.5 rounded text-white text-xs ${CH_STYLE[c.channel].bg}`}>{c.channel}</span></td>
                      <td className="px-3 py-1.5">{c.items.map((i) => `${i.code} ${i.name} ${i.qty}`).join(' / ')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </details>
        );
      })()}

      {detail && (() => {
        const c = active.find((x) => x.id === detail.id) || detail;
        const room = roomOf(c.room);
        const left = c.endAt - now;
        return (
          <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4" onClick={() => setDetail(null)}>
            <div className="bg-white rounded-2xl p-5 w-full max-w-md space-y-2" onClick={(e) => e.stopPropagation()}>
              <div className="flex items-center gap-2">
                <span className="text-3xl font-extrabold">{c.cartNo}번</span>
                <span className={`px-2 py-1 rounded text-white font-bold ${CH_STYLE[c.channel].bg}`}>{c.channel}</span>
                <button onClick={() => setDetail(null)} className="ml-auto text-2xl text-gray-400">✕</button>
              </div>
              <div>{room?.name} · {room ? slotLabel(room, c.slot) : ''}</div>
              <div className={`text-xl font-bold ${left <= 0 ? 'text-rose-600' : ''}`}>{left <= 0 ? '냉각 종료 · 출고 대기' : `${fmtLeft(left)} 남음`} <span className="text-sm font-normal text-gray-500">{hhmm(c.startAt)} → {hhmm(c.endAt)}</span></div>
              {c.items.map((i) => <div key={i.code} className="text-sm"><b className="font-mono">{i.code}</b> {i.name} · {i.qty}개</div>)}
              <div className="text-xs text-gray-400 pt-2">출고·이동은 「외포장 입력」 화면에서 합니다.</div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}

function ConfigPanel({ cfg, onSave }: { cfg: CoolingConfig; onSave: (c: CoolingConfig) => Promise<void> }) {
  const [c, setC] = useState<CoolingConfig>(cfg);
  const [busy, setBusy] = useState(false);
  const letters = Array.from(new Set([...Object.keys(DEFAULT_CONFIG.durations), ...Object.keys(c.durations)])).sort();
  const [newLetter, setNewLetter] = useState('');
  return (
    <div className="bg-white border rounded-xl p-4 space-y-4">
      <div>
        <div className="font-bold text-sm mb-2">냉각실 도면 <span className="font-normal text-gray-500 text-xs">— 채우는 순서: 맨 오른쪽 줄을 안쪽→입구로 채우고, 다 차면 왼쪽 줄로</span></div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          {c.rooms.map((r, i) => (
            <div key={r.id} className="border rounded-lg p-3 space-y-2">
              <input value={r.name} onChange={(e) => { const rooms = [...c.rooms]; rooms[i] = { ...r, name: e.target.value }; setC({ ...c, rooms }); }}
                className="w-full border rounded px-2 py-1 font-bold" />
              <div className="flex items-center gap-2 text-sm">
                줄
                <input type="number" min={1} max={20} value={r.cols}
                  onChange={(e) => { const rooms = [...c.rooms]; rooms[i] = { ...r, cols: Math.max(1, Math.min(20, Number(e.target.value) || 1)) }; setC({ ...c, rooms }); }}
                  className="w-16 border rounded px-2 py-1" />개 × 한 줄에
                <input type="number" min={1} max={20} value={r.rows}
                  onChange={(e) => { const rooms = [...c.rooms]; rooms[i] = { ...r, rows: Math.max(1, Math.min(20, Number(e.target.value) || 1)) }; setC({ ...c, rooms }); }}
                  className="w-16 border rounded px-2 py-1" />대
                <span className="text-gray-500">= {r.rows * r.cols}대</span>
              </div>
            </div>
          ))}
        </div>
        <div className="text-xs text-amber-700 mt-1">도면을 줄이면 바깥으로 밀린 대차는 「자리 미지정」으로 보입니다 (꾹 눌러 다시 배치).</div>
      </div>
      <div>
        <div className="font-bold text-sm mb-2">단계별 냉각 시간 (분) <span className="font-normal text-gray-500 text-xs">— 품목코드 첫 글자 기준. 한 대차에 섞이면 가장 긴 시간</span></div>
        <div className="flex flex-wrap gap-2 items-center">
          {letters.map((L) => (
            <label key={L} className="flex items-center gap-1 border rounded px-2 py-1">
              <b className="w-4">{L}</b>
              <input type="number" min={1} value={c.durations[L] ?? c.defaultMin}
                onChange={(e) => setC({ ...c, durations: { ...c.durations, [L]: Math.max(1, Number(e.target.value) || 1) } })}
                className="w-16 border rounded px-1 py-0.5 text-right" />
            </label>
          ))}
          <label className="flex items-center gap-1 border rounded px-2 py-1 bg-gray-50">
            그 외
            <input type="number" min={1} value={c.defaultMin} onChange={(e) => setC({ ...c, defaultMin: Math.max(1, Number(e.target.value) || 1) })}
              className="w-16 border rounded px-1 py-0.5 text-right" />
          </label>
          <input value={newLetter} onChange={(e) => setNewLetter(e.target.value.toUpperCase().slice(0, 1))} placeholder="글자" className="w-14 border rounded px-2 py-1" />
          <button onClick={() => { if (newLetter) { setC({ ...c, durations: { ...c.durations, [newLetter]: c.defaultMin } }); setNewLetter(''); } }}
            className="px-2 py-1 border rounded text-sm">＋ 단계 추가</button>
        </div>
        <div className="text-xs text-gray-500 mt-1">바꾼 시간은 이후 입고분부터 적용됩니다 (이미 냉각 중인 대차는 그대로).</div>
      </div>
      <div className="flex justify-end gap-2">
        <button onClick={() => setC(cfg)} className="px-4 py-2 border rounded">되돌리기</button>
        <button disabled={busy} onClick={async () => { setBusy(true); try { await onSave(c); } finally { setBusy(false); } }}
          className="px-4 py-2 bg-blue-600 text-white rounded font-bold">{busy ? '저장 중…' : '저장'}</button>
      </div>
    </div>
  );
}
