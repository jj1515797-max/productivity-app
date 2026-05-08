import { useEffect, useMemo, useState } from 'react';
import { collection, doc, onSnapshot, setDoc } from 'firebase/firestore';
import { db } from '../firebase';
import { todayKey } from '../lib/dateUtil';
import { loadViewDate, saveViewDate } from '../lib/viewDate';
import type { AttendanceRecord, Item, MachineEntry, Member, ProductSetting } from '../types';
import { summarizeAttendance } from '../lib/attendance';
import { convertErpCode, normalizeCode } from '../lib/codeUtil';

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

  // 자동 계산 데이터: 조직도 + 생산 entries + 제품 DB
  const [members, setMembers] = useState<Member[]>([]);
  const [attendRecords, setAttendRecords] = useState<Record<string, AttendanceRecord>>({});
  const [entries, setEntries] = useState<MachineEntry[]>([]);
  const [items, setItems] = useState<Item[]>([]);
  const [productSettings, setProductSettings] = useState<Record<string, ProductSetting>>({});

  useEffect(() => {
    setData({});
    return onSnapshot(doc(db, 'productivity', date), (snap) => {
      setData(snap.exists() ? (snap.data() as DayData) : {});
    });
  }, [date]);

  useEffect(() => {
    return onSnapshot(collection(db, 'members'), (snap) => {
      const list: Member[] = [];
      snap.forEach((d) => {
        const data = d.data() as Member;
        if (data.active !== false) list.push({ ...data, id: d.id });
      });
      setMembers(list);
    });
  }, []);

  useEffect(() => {
    setAttendRecords({});
    return onSnapshot(collection(db, 'attendance', date, 'records'), (snap) => {
      const map: Record<string, AttendanceRecord> = {};
      snap.forEach((d) => { map[d.id] = d.data() as AttendanceRecord; });
      setAttendRecords(map);
    });
  }, [date]);

  useEffect(() => {
    setEntries([]);
    const machines = ['1호기', '2호기', '3호기'] as const;
    const unsubs = machines.map((m) =>
      onSnapshot(collection(db, 'days', date, 'machines', m, 'entries'), (snap) => {
        setEntries((prev) => {
          const others = prev.filter((e) => e.machine !== m);
          const list: MachineEntry[] = [];
          snap.forEach((d) => list.push(d.data() as MachineEntry));
          return [...others, ...list];
        });
      })
    );
    return () => unsubs.forEach((u) => u());
  }, [date]);

  useEffect(() => {
    setItems([]);
    return onSnapshot(collection(db, 'days', date, 'items'), (snap) => {
      const list: Item[] = [];
      snap.forEach((d) => list.push(d.data() as Item));
      setItems(list);
    });
  }, [date]);

  useEffect(() => {
    return onSnapshot(collection(db, 'productSettings'), (snap) => {
      const map: Record<string, ProductSetting> = {};
      snap.forEach((d) => { map[d.id] = d.data() as ProductSetting; });
      setProductSettings(map);
    });
  }, []);

  // 자동 계산 결과
  const attendanceSummary = useMemo(
    () => summarizeAttendance(members, attendRecords, date),
    [members, attendRecords, date]
  );

  // 정규화된 키로 productSettings를 다시 인덱싱 (A-001-01 ↔ A-01 호환)
  const settingsByNormalized = useMemo(() => {
    const map = new Map<string, ProductSetting>();
    Object.entries(productSettings).forEach(([key, val]) => {
      map.set(normalizeCode(key), val);
      map.set(normalizeCode(convertErpCode(key)), val);
    });
    return map;
  }, [productSettings]);

  // items 의 totalQty 기준 (당일 생산 예정 총수량)
  const productionByType = useMemo(() => {
    let pot = 0, bat = 0, untyped = 0;
    const untypedCodes = new Set<string>();
    items.forEach((it) => {
      const code = it.code;
      const setting =
        settingsByNormalized.get(normalizeCode(code)) ||
        settingsByNormalized.get(normalizeCode(convertErpCode(code)));
      const qty = it.totalQty || 0;
      if (qty <= 0) return;
      if (setting?.type === '냄비') pot += qty;
      else if (setting?.type === '바트') bat += qty;
      else { untyped += qty; untypedCodes.add(code); }
    });
    return { pot, bat, untyped, untypedCodes: Array.from(untypedCodes), itemCount: items.length };
  }, [items, settingsByNormalized]);

  const auto = {
    attend: attendanceSummary.workforceN,
    leave: attendanceSummary.leaveDays,
    pot: productionByType.pot,
    bat: productionByType.bat,
  };

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
              <div>
                <h3 className="font-bold text-gray-800 flex items-center gap-2">⚙️ 관리자 입력</h3>
                <div className="text-[11px] text-gray-500 mt-0.5">조직도/생산 데이터에서 자동 계산됩니다 (필요시 수정)</div>
              </div>
              <button onClick={() => setShowAdmin(false)} className="w-7 h-7 rounded-full hover:bg-gray-200 text-gray-500">×</button>
            </div>
            <div className="p-5 space-y-3">
              {/* 매칭 진단 (당일 발주 총수량 기준) */}
              {items.length > 0 && (
                <div className="text-[11px] bg-blue-50 border border-blue-200 rounded p-2 text-blue-800 leading-relaxed">
                  오늘 발주 <b>{items.length}품목</b> · 냄비 <b>{auto.pot.toLocaleString()}EA</b> · 바트 <b>{auto.bat.toLocaleString()}EA</b>
                  {productionByType.untyped > 0 && (
                    <div className="mt-1 text-orange-700">
                      ⚠ 미분류 <b>{productionByType.untyped.toLocaleString()}EA</b> ({productionByType.untypedCodes.slice(0, 8).join(', ')}{productionByType.untypedCodes.length > 8 ? ' …' : ''})
                      <div className="text-[10px] mt-0.5">분석 → 설정 → 제품DB에서 냄비/바트로 분류해주세요</div>
                    </div>
                  )}
                </div>
              )}
              {items.length === 0 && (
                <div className="text-[11px] bg-gray-50 border rounded p-2 text-gray-500">
                  오늘 발주 데이터가 아직 없습니다 — 현황에서 ERP 데이터를 등록해주세요
                </div>
              )}
              <AutoNumberRow
                label="출근인원"
                value={data.attend}
                autoValue={auto.attend}
                onSave={(v) => save('attend', v)}
                saving={savingFields.has('attend')}
                unit="명"
                hint="총원 − 휴직 − 휴무"
              />
              <AutoNumberRow
                label="연차"
                value={data.leave}
                autoValue={auto.leave}
                onSave={(v) => save('leave', v)}
                saving={savingFields.has('leave')}
                unit="명"
                allowDecimal
                hint="연차 1·반차 0.5·반반차 0.25"
              />
              <AutoNumberRow
                label="냄비 수량"
                value={data.pot}
                autoValue={auto.pot}
                onSave={(v) => save('pot', v)}
                saving={savingFields.has('pot')}
                unit="개"
                hint="제품DB 냄비 종 합계"
              />
              <AutoNumberRow
                label="바트 수량"
                value={data.bat}
                autoValue={auto.bat}
                onSave={(v) => save('bat', v)}
                saving={savingFields.has('bat')}
                unit="개"
                hint="제품DB 바트 종 합계"
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

function AutoNumberRow({
  label, value, autoValue, onSave, saving, unit, hint, allowDecimal,
}: {
  label: string;
  value?: number;
  autoValue: number;
  onSave: (v: number | null) => void;
  saving: boolean;
  unit: string;
  hint?: string;
  allowDecimal?: boolean;
}) {
  const overridden = value !== undefined && value !== null;
  const displayed = overridden ? (value as number) : autoValue;
  const fmt = (v: number) => allowDecimal ? v.toString() : String(Math.round(v));

  // autoValue 가 0 이고 수동 입력 안된 상태면 입력창은 비우고 placeholder 로만 안내
  const showEmptyInput = !overridden && autoValue === 0;
  const [local, setLocal] = useState<string>(showEmptyInput ? '' : fmt(displayed));
  const [focused, setFocused] = useState(false);

  // 포커스 안 된 동안에만 외부 값 변경을 동기화 (타이핑 중 덮어쓰기 방지)
  useEffect(() => {
    if (focused) return;
    setLocal(showEmptyInput ? '' : fmt(displayed));
  }, [displayed, showEmptyInput, focused]);

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-baseline gap-2 flex-1 min-w-0">
          <label className="font-semibold text-gray-700 text-sm">{label}</label>
          {overridden ? (
            <span className="text-[10px] text-orange-600 font-bold">수동</span>
          ) : (
            <span className="text-[10px] text-emerald-600 font-bold">자동</span>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          <input
            type="text"
            inputMode={allowDecimal ? 'decimal' : 'numeric'}
            value={local}
            placeholder={showEmptyInput ? '0' : ''}
            onFocus={(e) => { setFocused(true); e.currentTarget.select(); }}
            onChange={(e) => setLocal(e.target.value)}
            onBlur={() => {
              setFocused(false);
              const trimmed = local.trim();
              if (trimmed === '') { onSave(null); return; }
              const v = Number(trimmed);
              if (!isNaN(v)) {
                if (v === autoValue) onSave(null);
                else onSave(v);
              }
            }}
            className="w-24 border rounded-md px-3 py-2 text-base text-center font-bold focus:outline-none focus:ring-2 focus:ring-blue-300"
          />
          <span className="text-xs text-gray-500 w-6">{unit}</span>
          <span className={`text-[10px] w-3 ${saving ? 'text-emerald-500' : 'text-transparent'}`}>●</span>
        </div>
      </div>
      <div className="flex items-center justify-between text-[11px] text-gray-500 pl-1">
        <span>{hint}</span>
        {overridden && (
          <button
            onClick={() => { setLocal(fmt(autoValue)); onSave(null); }}
            className="text-blue-600 hover:underline"
          >자동값 ({fmt(autoValue)}{unit})으로 복원</button>
        )}
      </div>
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
