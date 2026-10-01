/** 냉각실 도면 — 칸마다 대차 번호·채널 색·남은 시간.
 *  위쪽이 안쪽, 아래쪽이 입구. 꾹 누르면(0.5초) 이동 모드 → 옮길 칸을 탭. */
import { useRef } from 'react';
import { CH_SHORT, CH_STYLE, fmtLeft } from '../lib/cooling';
import type { CoolingCart, RoomConfig } from '../lib/cooling';

export default function CoolingRoomMap({
  room, carts, now, compact = false, moving, onTapCart, onLongPressCart, onTapSlot,
}: {
  room: RoomConfig;
  carts: CoolingCart[];
  now: number;
  compact?: boolean;
  moving?: CoolingCart | null;
  onTapCart?: (c: CoolingCart) => void;
  onLongPressCart?: (c: CoolingCart) => void;
  onTapSlot?: (slot: number) => void;
}) {
  const bySlot = new Map<number, CoolingCart>();
  carts.forEach((c) => { if (c.slot >= 0) bySlot.set(c.slot, c); });
  const unplaced = carts.filter((c) => c.slot < 0 || c.slot >= room.rows * room.cols);
  const timer = useRef<number | null>(null);
  const longFired = useRef(false);

  const press = (c: CoolingCart) => {
    longFired.current = false;
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => { longFired.current = true; onLongPressCart?.(c); }, 500);
  };
  const release = () => { if (timer.current) { window.clearTimeout(timer.current); timer.current = null; } };

  const cell = compact ? 'min-h-[52px] text-[10px]' : 'min-h-[76px] text-xs';
  const doneCount = carts.filter((c) => now >= c.endAt).length;

  return (
    <div className="bg-white border rounded-xl overflow-hidden">
      <div className="px-3 py-2 border-b bg-slate-50 flex items-center gap-2">
        <span className="font-bold text-gray-800">{room.name}</span>
        <span className="text-xs text-gray-500">{carts.length}대 / {room.rows * room.cols}칸</span>
        {doneCount > 0 && <span className="text-xs font-bold text-rose-600 animate-pulse">냉각 종료 {doneCount}대</span>}
      </div>
      <div className="p-2">
        <div className="text-[10px] text-gray-400 text-center mb-1">▲ 안쪽</div>
        <div className="grid gap-1" style={{ gridTemplateColumns: `repeat(${room.cols}, minmax(0, 1fr))` }}>
          {Array.from({ length: room.rows * room.cols }, (_, slot) => {
            const c = bySlot.get(slot);
            const isTarget = !!moving && moving.id !== c?.id;
            if (!c) {
              return (
                <button key={slot} type="button" onClick={() => onTapSlot?.(slot)}
                  className={`${cell} rounded border border-dashed ${isTarget ? 'border-blue-400 bg-blue-50' : 'border-gray-200 bg-gray-50/50'}`} />
              );
            }
            const left = c.endAt - now;
            const done = left <= 0;
            const st = CH_STYLE[c.channel];
            const isMoving = moving?.id === c.id;
            return (
              <button key={slot} type="button"
                onPointerDown={() => press(c)} onPointerUp={release} onPointerLeave={release} onPointerCancel={release}
                onContextMenu={(e) => e.preventDefault()}
                onClick={() => {
                  if (longFired.current) { longFired.current = false; return; }
                  if (moving && !isMoving) onTapSlot?.(slot); else onTapCart?.(c);
                }}
                className={`${cell} rounded border-2 p-1 text-left leading-tight select-none relative overflow-hidden
                  ${done ? 'border-rose-500 bg-rose-50 animate-pulse' : `${st.border} ${st.soft}`}
                  ${isMoving ? 'ring-4 ring-blue-500' : ''} ${isTarget ? 'outline outline-2 outline-blue-300' : ''}`}>
                <span className={`absolute left-0 top-0 bottom-0 w-1.5 ${st.dot}`} />
                <div className="pl-1.5">
                  <div className={`font-extrabold ${compact ? 'text-sm' : 'text-lg'} text-gray-900`}>{c.cartNo}</div>
                  <div className={`${st.text} font-semibold truncate`}>{CH_SHORT[c.channel]}</div>
                  {!compact && <div className="text-gray-600 font-mono break-all line-clamp-2" title={c.items.map((i) => `${i.code} ${i.name}`).join('\n')}>{c.items.map((i) => i.code).join(' ')}</div>}
                  <div className={`font-bold tabular-nums ${done ? 'text-rose-600' : 'text-gray-700'}`}>{done ? '종료' : fmtLeft(left)}</div>
                </div>
              </button>
            );
          })}
        </div>
        <div className="text-[10px] text-gray-400 text-center mt-1">▼ 입구</div>
        {unplaced.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1 items-center">
            <span className="text-[11px] text-amber-700">자리 미지정:</span>
            {unplaced.map((c) => (
              <button key={c.id} type="button" onClick={() => onTapCart?.(c)}
                onPointerDown={() => press(c)} onPointerUp={release} onPointerLeave={release}
                className={`px-2 py-1 rounded border-2 text-xs font-bold ${now >= c.endAt ? 'border-rose-500 bg-rose-50' : `${CH_STYLE[c.channel].border} ${CH_STYLE[c.channel].soft}`}`}>
                {c.cartNo} · {c.channel}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
