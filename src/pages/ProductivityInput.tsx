import { useEffect, useMemo, useState } from 'react';
import { doc, onSnapshot, setDoc } from 'firebase/firestore';
import { db } from '../firebase';
import { todayKey } from '../lib/dateUtil';
import { loadViewDate, saveViewDate } from '../lib/viewDate';

type StageKey = 'bg' | 'ck' | 'fl' | 'pk';

const STAGES: { key: StageKey; label: string; tone: string }[] = [
  { key: 'bg', label: '배합',   tone: 'border-blue-500' },
  { key: 'ck', label: '취반기', tone: 'border-emerald-500' },
  { key: 'fl', label: '화구',   tone: 'border-orange-500' },
  { key: 'pk', label: '내포장', tone: 'border-violet-500' },
];

type DayData = {
  date?: string;
  pot?: number;
  bat?: number;
  attend?: number;
  leave?: number;
  bg_people?: number; bg_start?: string; bg_end?: string;
  ck_people?: number; ck_start?: string; ck_end?: string;
  fl_people?: number; fl_start?: string; fl_end?: string;
  pk_people?: number; pk_start?: string; pk_end?: string;
};

function shiftDate(dateStr: string, delta: number): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const date = new Date(y, m - 1, d + delta);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function dateLabel(dateStr: string): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  const days = ['일', '월', '화', '수', '목', '금', '토'];
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')} (${days[date.getDay()]})`;
}

function nowHHMM(): string {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function formatTimeInput(raw: string): string {
  const v = raw.replace(/[^0-9]/g, '').slice(0, 4);
  if (v.length >= 3) return `${v.slice(0, 2)}:${v.slice(2)}`;
  return v;
}

function isValidTime(v: string): boolean {
  return /^\d{2}:\d{2}$/.test(v);
}

export default function ProductivityInput() {
  const [date, setDate] = useState(loadViewDate);
  useEffect(() => { saveViewDate(date); }, [date]);

  const [data, setData] = useState<DayData>({});
  const [showAdmin, setShowAdmin] = useState(false);
  const [savingFields, setSavingFields] = useState<Set<string>>(new Set());

  useEffect(() => {
    setData({});
    return onSnapshot(doc(db, 'productivity', date), (snap) => {
      setData(snap.exists() ? (snap.data() as DayData) : {});
    });
  }, [date]);

  const save = async (field: keyof DayData, value: any) => {
    setSavingFields((s) => new Set(s).add(field));
    try {
      const update: Record<string, any> = { date };
      update[field] = value === '' || value === null || value === undefined ? null : value;
      await setDoc(doc(db, 'productivity', date), update, { merge: true });
    } finally {
      setSavingFields((s) => { const n = new Set(s); n.delete(field); return n; });
    }
  };

  // 진행률: 12개 필드 (4 stage × 3)
  const progress = useMemo(() => {
    const fields: (keyof DayData)[] = [
      'bg_people', 'bg_start', 'bg_end',
      'ck_people', 'ck_start', 'ck_end',
      'fl_people', 'fl_start', 'fl_end',
      'pk_people', 'pk_start', 'pk_end',
    ];
    let filled = 0;
    fields.forEach((f) => {
      const v = data[f];
      if (v !== undefined && v !== null && v !== '' && !(typeof v === 'number' && isNaN(v))) filled++;
    });
    return Math.round((filled / fields.length) * 100);
  }, [data]);

  const isToday = date === todayKey();
  const adminFilled =
    (data.attend !== undefined && data.attend !== null) ||
    (data.leave !== undefined && data.leave !== null) ||
    (data.pot !== undefined && data.pot !== null) ||
    (data.bat !== undefined && data.bat !== null);

  return (
    <div className="space-y-4 max-w-2xl mx-auto">
      {/* 헤더 */}
      <div className="bg-white border rounded-lg p-3 flex items-center gap-2 flex-wrap">
        <button
          onClick={() => setDate(shiftDate(date, -1))}
          className="w-9 h-9 flex items-center justify-center rounded-full hover:bg-gray-100"
          aria-label="이전"
        >◀</button>
        <span className="font-bold text-gray-800 text-sm min-w-[150px] text-center">{dateLabel(date)}</span>
        <button
          onClick={() => setDate(shiftDate(date, 1))}
          className="w-9 h-9 flex items-center justify-center rounded-full hover:bg-gray-100"
          aria-label="다음"
        >▶</button>
        <input
          type="date"
          value={date}
          onChange={(e) => e.target.value && setDate(e.target.value)}
          className="border rounded px-2 py-1 text-sm"
        />
        {!isToday && (
          <button
            onClick={() => setDate(todayKey())}
            className="px-2.5 py-1 text-xs rounded border border-blue-300 text-blue-700 bg-blue-50 hover:bg-blue-100 font-medium"
          >오늘로</button>
        )}
        <button
          onClick={() => setShowAdmin(true)}
          className={`ml-auto px-3 py-2 rounded-md font-medium text-sm shadow-sm flex items-center gap-1.5 ${
            adminFilled ? 'bg-slate-700 text-white hover:bg-slate-800' : 'bg-white border hover:bg-gray-100 text-gray-700'
          }`}
          title="관리자 입력"
        >
          <span>⚙️</span> 관리자
          {adminFilled && <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />}
        </button>
      </div>

      {/* 진행률 게이지 */}
      <div className="bg-white border rounded-lg p-4">
        <div className="flex items-center justify-between mb-2">
          <span className="text-sm font-bold text-gray-800">현장 입력 진행률</span>
          <span className="text-sm font-bold text-blue-700">{progress}%</span>
        </div>
        <div className="relative w-full h-5 bg-gray-100 rounded-full overflow-hidden shadow-inner">
          <div
            className="absolute left-0 top-0 h-full bg-gradient-to-r from-blue-500 to-blue-600 transition-all duration-300"
            style={{ width: `${progress}%` }}
          />
          <div className={`absolute inset-0 flex items-center justify-center text-[11px] font-bold ${progress > 50 ? 'text-white' : 'text-gray-700'}`}>
            12 항목 중 {Math.round((progress / 100) * 12)} 입력
          </div>
        </div>
      </div>

      {/* 4개 스테이지 카드 */}
      {STAGES.map((stage) => {
        const peopleK = `${stage.key}_people` as keyof DayData;
        const startK  = `${stage.key}_start`  as keyof DayData;
        const endK    = `${stage.key}_end`    as keyof DayData;
        return (
          <div key={stage.key} className={`bg-white border-l-4 ${stage.tone} border-y border-r rounded-lg p-4 shadow-sm`}>
            <div className="font-bold text-base text-gray-800 mb-3">{stage.label}</div>
            <div className="space-y-2.5">
              <NumberRow
                label="인원"
                value={data[peopleK] as number | undefined}
                onSave={(v) => save(peopleK, v)}
                saving={savingFields.has(peopleK)}
                unit="명"
              />
              <TimeRow
                label="시작"
                value={data[startK] as string | undefined}
                onSave={(v) => save(startK, v)}
                saving={savingFields.has(startK)}
                color="blue"
              />
              <TimeRow
                label="종료"
                value={data[endK] as string | undefined}
                onSave={(v) => save(endK, v)}
                saving={savingFields.has(endK)}
                color="rose"
              />
            </div>
          </div>
        );
      })}

      {/* 관리자 모달 */}
      {showAdmin && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-sm overflow-hidden">
            <div className="px-5 py-4 border-b bg-gradient-to-r from-slate-50 to-gray-50 flex items-center justify-between">
              <h3 className="font-bold text-gray-800 flex items-center gap-2">⚙️ 관리자 입력</h3>
              <button onClick={() => setShowAdmin(false)} className="w-7 h-7 rounded-full hover:bg-gray-200 text-gray-500">×</button>
            </div>
            <div className="p-5 space-y-3">
              <NumberRow
                label="출근인원"
                value={data.attend}
                onSave={(v) => save('attend', v)}
                saving={savingFields.has('attend')}
                unit="명"
              />
              <NumberRow
                label="연차"
                value={data.leave}
                onSave={(v) => save('leave', v)}
                saving={savingFields.has('leave')}
                unit="명"
              />
              <NumberRow
                label="냄비 수량"
                value={data.pot}
                onSave={(v) => save('pot', v)}
                saving={savingFields.has('pot')}
                unit="개"
              />
              <NumberRow
                label="바트 수량"
                value={data.bat}
                onSave={(v) => save('bat', v)}
                saving={savingFields.has('bat')}
                unit="개"
              />
            </div>
            <div className="px-5 py-3 border-t bg-slate-50">
              <button
                onClick={() => setShowAdmin(false)}
                className="w-full px-4 py-2.5 bg-slate-700 text-white rounded font-medium hover:bg-slate-800"
              >닫기</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function NumberRow({
  label, value, onSave, saving, unit,
}: {
  label: string;
  value?: number;
  onSave: (v: number | null) => void;
  saving: boolean;
  unit: string;
}) {
  const [local, setLocal] = useState<string>(value !== undefined && value !== null ? String(value) : '');
  useEffect(() => {
    setLocal(value !== undefined && value !== null ? String(value) : '');
  }, [value]);
  return (
    <div className="flex items-center justify-between gap-2">
      <label className="font-semibold text-gray-700 text-sm flex-1">{label}</label>
      <div className="flex items-center gap-1.5">
        <input
          type="number"
          inputMode="numeric"
          value={local}
          onChange={(e) => setLocal(e.target.value)}
          onBlur={() => {
            const v = local.trim() === '' ? null : Number(local);
            if (v === null || !isNaN(v)) onSave(v);
          }}
          className="w-24 border rounded-md px-3 py-2 text-base text-center font-bold focus:outline-none focus:ring-2 focus:ring-blue-300"
        />
        <span className="text-xs text-gray-500 w-6">{unit}</span>
        <span className={`text-[10px] w-3 ${saving ? 'text-emerald-500' : 'text-transparent'}`}>●</span>
      </div>
    </div>
  );
}

function TimeRow({
  label, value, onSave, saving, color,
}: {
  label: string;
  value?: string;
  onSave: (v: string | null) => void;
  saving: boolean;
  color: 'blue' | 'rose';
}) {
  const [local, setLocal] = useState<string>(value || '');
  useEffect(() => { setLocal(value || ''); }, [value]);
  const filled = isValidTime(local);
  const colors = {
    blue: filled ? 'bg-blue-600 text-white' : 'bg-blue-50 text-blue-700 border border-blue-200',
    rose: filled ? 'bg-rose-600 text-white' : 'bg-rose-50 text-rose-700 border border-rose-200',
  };
  return (
    <div className="flex items-center justify-between gap-2">
      <button
        onClick={() => {
          const t = nowHHMM();
          setLocal(t);
          onSave(t);
        }}
        className={`min-w-[70px] px-3 py-2 rounded-md font-bold text-sm transition ${colors[color]}`}
      >
        {label}
      </button>
      <div className="flex items-center gap-1.5">
        <input
          type="text"
          inputMode="numeric"
          value={local}
          maxLength={5}
          placeholder="00:00"
          onChange={(e) => setLocal(formatTimeInput(e.target.value))}
          onBlur={() => {
            if (local === '') onSave(null);
            else if (isValidTime(local)) onSave(local);
          }}
          className="w-24 border rounded-md px-3 py-2 text-base text-center font-bold tracking-wider focus:outline-none focus:ring-2 focus:ring-blue-300"
        />
        <span className="text-xs text-gray-500 w-6"></span>
        <span className={`text-[10px] w-3 ${saving ? 'text-emerald-500' : 'text-transparent'}`}>●</span>
      </div>
    </div>
  );
}
