/** 지난 날짜에 넣고 출고(또는 대기 정리)를 안 한 대차 — 오늘 화면 맨 위에 따로 모아 보여 준다.
 *  오늘 대수·종료 알람·외포장 경고등에는 섞지 않는다. onReleaseAll 을 주면 「모두 출고 처리」 버튼 */
import type { CoolingCart } from '../lib/cooling';
import { CH_STYLE } from '../lib/cooling';

export default function StaleCarts({ stale, roomName, onReleaseAll }: {
  stale: CoolingCart[];
  roomName: (id: number) => string;
  onReleaseAll?: () => void;
}) {
  if (stale.length === 0) return null;
  const list = [...stale].sort((a, b) => a.date.localeCompare(b.date) || Number(a.cartNo) - Number(b.cartNo));
  const dates = [...new Set(list.map((c) => c.date.slice(5)))].join(', ');
  return (
    <section className="bg-rose-50 border-2 border-rose-300 rounded-xl p-3 space-y-2">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="font-bold text-rose-800">⚠ 지난 날짜({dates})에 넣고 출고 안 한 대차 {list.length}대</span>
        <span className="text-xs text-rose-700">오늘 대수·종료 알람에서는 빠져 있습니다. 실제로 다 뺐으면 정리해 주세요.</span>
        {onReleaseAll
          ? <button onClick={onReleaseAll} className="ml-auto px-4 py-2 rounded-lg bg-rose-600 text-white font-bold active:scale-95">모두 출고 처리</button>
          : <span className="ml-auto text-xs text-rose-700">정리는 외포장 입력 화면에서</span>}
      </div>
      <div className="flex flex-wrap gap-1.5">
        {list.map((c) => (
          <span key={c.id} className="px-2 py-1 rounded-lg bg-white border border-rose-200 text-sm flex items-center gap-1.5">
            <span className="text-xs text-gray-500 tabular-nums">{c.date.slice(5)}</span>
            <b>{c.cartNo}번</b>
            <span className={`px-1.5 rounded text-white text-[11px] font-bold ${CH_STYLE[c.channel].bg}`}>{c.channel}</span>
            <span className="text-xs text-gray-600">{c.waiting ? '대기' : roomName(c.room)}</span>
          </span>
        ))}
      </div>
    </section>
  );
}
