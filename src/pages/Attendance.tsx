import { useEffect, useMemo, useState } from 'react';
import { addDoc, collection, deleteDoc, doc, onSnapshot, setDoc, updateDoc } from 'firebase/firestore';
import { db } from '../firebase';
import { todayKey } from '../lib/dateUtil';
import { loadViewDate, saveViewDate } from '../lib/viewDate';
import type { AttendanceRecord, AttendanceStatus, Member } from '../types';
import { ATTENDANCE_STATUSES } from '../types';

const STATUS_COLOR: Record<AttendanceStatus, { chip: string; soft: string; text: string; border: string }> = {
  출근:    { chip: 'bg-emerald-500', soft: 'bg-emerald-50', text: 'text-emerald-700', border: 'border-emerald-300' },
  연차:    { chip: 'bg-orange-500',  soft: 'bg-orange-50',  text: 'text-orange-700',  border: 'border-orange-300' },
  반차:    { chip: 'bg-amber-500',   soft: 'bg-amber-50',   text: 'text-amber-700',   border: 'border-amber-300' },
  결혼반차: { chip: 'bg-pink-500',    soft: 'bg-pink-50',    text: 'text-pink-700',    border: 'border-pink-300' },
  병가:    { chip: 'bg-red-500',     soft: 'bg-red-50',     text: 'text-red-700',     border: 'border-red-300' },
  경조사:  { chip: 'bg-violet-500',  soft: 'bg-violet-50',  text: 'text-violet-700',  border: 'border-violet-300' },
  휴무:    { chip: 'bg-gray-400',    soft: 'bg-gray-100',   text: 'text-gray-600',    border: 'border-gray-300' },
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

export default function Attendance() {
  const [date, setDate] = useState(loadViewDate);
  useEffect(() => { saveViewDate(date); }, [date]);

  const [members, setMembers] = useState<Member[]>([]);
  const [records, setRecords] = useState<Record<string, AttendanceRecord>>({});
  const [search, setSearch] = useState('');
  const [showAdd, setShowAdd] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editDept, setEditDept] = useState('');

  useEffect(() => {
    return onSnapshot(collection(db, 'members'), (snap) => {
      const list: Member[] = [];
      snap.forEach((d) => {
        const data = d.data() as Member;
        if (data.active !== false) list.push({ ...data, id: d.id });
      });
      list.sort((a, b) => (a.dept || '').localeCompare(b.dept || '') || a.name.localeCompare(b.name));
      setMembers(list);
    });
  }, []);

  useEffect(() => {
    setRecords({});
    return onSnapshot(collection(db, 'attendance', date, 'records'), (snap) => {
      const map: Record<string, AttendanceRecord> = {};
      snap.forEach((d) => { map[d.id] = d.data() as AttendanceRecord; });
      setRecords(map);
    });
  }, [date]);

  const counts = useMemo(() => {
    const totalN = members.length;
    const breakdown: Record<AttendanceStatus, number> = {
      출근: 0, 연차: 0, 반차: 0, 결혼반차: 0, 병가: 0, 경조사: 0, 휴무: 0,
    };
    members.forEach((m) => {
      const status = (records[m.id]?.status as AttendanceStatus) || '출근';
      breakdown[status]++;
    });
    const presentN = breakdown.출근;
    const restN = breakdown.휴무;
    const leaveN = totalN - presentN - restN; // 연차/반차/결혼반차/병가/경조사 합산
    const workforceN = totalN - restN; // 휴무 제외 (생산성 분모)
    return { totalN, presentN, leaveN, restN, workforceN, breakdown };
  }, [members, records]);

  const grouped = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = q
      ? members.filter((m) => m.name.toLowerCase().includes(q) || (m.dept || '').toLowerCase().includes(q))
      : members;
    const map = new Map<string, Member[]>();
    list.forEach((m) => {
      const key = m.dept || '미지정';
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(m);
    });
    return Array.from(map.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [members, search]);

  const setStatus = async (m: Member, status: AttendanceStatus) => {
    if (status === '출근') {
      await deleteDoc(doc(db, 'attendance', date, 'records', m.id)).catch(() => {});
    } else {
      await setDoc(doc(db, 'attendance', date, 'records', m.id), {
        memberId: m.id, name: m.name, status, date,
      });
    }
  };

  const addMember = async (name: string, dept: string) => {
    if (!name.trim()) return;
    await addDoc(collection(db, 'members'), {
      name: name.trim(),
      dept: dept.trim(),
      active: true,
      createdAt: new Date().toISOString(),
    });
  };

  const updateMember = async (m: Member) => {
    if (!editName.trim()) return;
    await updateDoc(doc(db, 'members', m.id), {
      name: editName.trim(),
      dept: editDept.trim(),
    });
    setEditing(null);
  };

  const removeMember = async (m: Member) => {
    if (!confirm(`'${m.name}' 인원을 삭제할까요? (해당 인원의 모든 근태 기록은 유지되지만 목록에서 사라집니다)`)) return;
    await updateDoc(doc(db, 'members', m.id), { active: false });
  };

  const isToday = date === todayKey();

  return (
    <div className="space-y-5">
      {/* 날짜 헤더 */}
      <div className="bg-white border rounded-lg p-4 flex items-center gap-3 flex-wrap">
        <button
          onClick={() => setDate(shiftDate(date, -1))}
          className="w-10 h-10 flex items-center justify-center rounded-full hover:bg-gray-100 text-gray-700"
          aria-label="이전 날짜"
        >◀</button>
        <span className="font-bold text-base text-gray-800 min-w-[180px] text-center">{dateLabel(date)}</span>
        <button
          onClick={() => setDate(shiftDate(date, 1))}
          className="w-10 h-10 flex items-center justify-center rounded-full hover:bg-gray-100 text-gray-700"
          aria-label="다음 날짜"
        >▶</button>
        <input
          type="date"
          value={date}
          onChange={(e) => e.target.value && setDate(e.target.value)}
          className="border rounded px-2 py-1.5 text-sm"
        />
        {!isToday && (
          <button
            onClick={() => setDate(todayKey())}
            className="px-3 py-1.5 text-xs rounded border border-blue-300 text-blue-700 bg-blue-50 hover:bg-blue-100 font-medium"
          >오늘로</button>
        )}
        <div className="ml-auto text-xs text-gray-500">
          출근 분모 (휴무 제외) <span className="font-bold text-gray-800 ml-1">{counts.workforceN}명</span>
        </div>
      </div>

      {/* 카운트 카드 */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <StatCard label="총원" value={counts.totalN} unit="명" tone="indigo" highlight />
        <StatCard label="출근" value={counts.presentN} unit="명" tone="emerald" sub={counts.workforceN > 0 ? `${((counts.presentN / counts.workforceN) * 100).toFixed(1)}%` : ''} />
        <StatCard label="연차/반차 등" value={counts.leaveN} unit="명" tone="orange" />
        <StatCard label="휴무" value={counts.restN} unit="명" tone="gray" />
        <div className="bg-white border rounded-lg p-3 text-xs">
          <div className="text-gray-500 font-medium mb-1.5">상세 내역</div>
          <div className="grid grid-cols-2 gap-y-1 gap-x-2">
            {ATTENDANCE_STATUSES.map((s) => (
              <div key={s} className="flex items-center justify-between">
                <span className="flex items-center gap-1.5">
                  <span className={`w-1.5 h-1.5 rounded-full ${STATUS_COLOR[s].chip}`} />
                  <span className="text-gray-600">{s}</span>
                </span>
                <span className="font-bold text-gray-800">{counts.breakdown[s]}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* 검색/추가 바 */}
      <div className="bg-white border rounded-lg px-4 py-3 flex items-center gap-3 flex-wrap">
        <div className="relative flex-1 min-w-[240px]">
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="🔍 이름 또는 부서 검색..."
            className="w-full border rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-300"
          />
          {search && (
            <button onClick={() => setSearch('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600">×</button>
          )}
        </div>
        <span className="text-xs text-gray-500">{members.length}명 등록됨</span>
        <button
          onClick={() => setShowAdd(true)}
          className="px-3 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-md font-medium text-sm shadow-sm"
        >+ 인원 추가</button>
      </div>

      {/* 인원 목록 (부서별 그룹) */}
      {members.length === 0 ? (
        <div className="bg-white border rounded-lg p-12 text-center">
          <div className="text-gray-400 text-sm mb-3">등록된 인원이 없습니다</div>
          <button
            onClick={() => setShowAdd(true)}
            className="px-4 py-2 bg-blue-600 text-white rounded-md text-sm font-medium hover:bg-blue-700"
          >첫 인원 추가하기</button>
        </div>
      ) : (
        <div className="space-y-4">
          {grouped.map(([dept, list]) => (
            <div key={dept} className="bg-white border rounded-lg overflow-hidden">
              <div className="px-4 py-2.5 border-b bg-slate-50 font-semibold text-gray-800 text-sm flex items-center gap-2">
                <span>{dept}</span>
                <span className="text-xs text-gray-500 font-normal">{list.length}명</span>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 divide-x divide-y divide-gray-100" style={{ borderRight: 0 }}>
                {list.map((m) => {
                  const status = (records[m.id]?.status as AttendanceStatus) || '출근';
                  const color = STATUS_COLOR[status];
                  const isEdit = editing === m.id;
                  return (
                    <div key={m.id} className={`p-3 ${color.soft} relative group`}>
                      {isEdit ? (
                        <div className="space-y-2">
                          <input
                            value={editName}
                            onChange={(e) => setEditName(e.target.value)}
                            className="w-full border rounded px-2 py-1 text-sm"
                            placeholder="이름"
                          />
                          <input
                            value={editDept}
                            onChange={(e) => setEditDept(e.target.value)}
                            className="w-full border rounded px-2 py-1 text-xs"
                            placeholder="부서"
                          />
                          <div className="flex gap-1.5">
                            <button onClick={() => updateMember(m)} className="flex-1 px-2 py-1 bg-blue-600 text-white rounded text-xs font-medium hover:bg-blue-700">저장</button>
                            <button onClick={() => setEditing(null)} className="px-2 py-1 border rounded text-xs hover:bg-gray-100">취소</button>
                          </div>
                        </div>
                      ) : (
                        <>
                          <div className="flex items-start justify-between gap-2 mb-2">
                            <div className="min-w-0">
                              <div className="font-bold text-gray-900 truncate">{m.name}</div>
                              {m.dept && <div className="text-[10px] text-gray-500 truncate">{m.dept}</div>}
                            </div>
                            <div className="opacity-0 group-hover:opacity-100 transition flex gap-0.5 -mt-1">
                              <button
                                onClick={() => { setEditing(m.id); setEditName(m.name); setEditDept(m.dept || ''); }}
                                className="text-gray-400 hover:text-gray-700 text-xs px-1"
                                title="수정"
                              >✎</button>
                              <button
                                onClick={() => removeMember(m)}
                                className="text-gray-400 hover:text-red-600 text-xs px-1"
                                title="삭제"
                              >×</button>
                            </div>
                          </div>
                          <div className="relative">
                            <select
                              value={status}
                              onChange={(e) => setStatus(m, e.target.value as AttendanceStatus)}
                              className={`w-full px-2 py-1.5 rounded border-2 ${color.border} ${color.text} bg-white font-semibold text-sm cursor-pointer focus:outline-none focus:ring-2 focus:ring-blue-200 appearance-none pr-7`}
                            >
                              {ATTENDANCE_STATUSES.map((s) => (
                                <option key={s} value={s}>{s}</option>
                              ))}
                            </select>
                            <span className={`absolute right-2 top-1/2 -translate-y-1/2 pointer-events-none ${color.text} text-xs`}>▼</span>
                          </div>
                        </>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
          {grouped.length === 0 && search && (
            <div className="bg-white border rounded-lg p-8 text-center text-gray-400 text-sm">
              '{search}' 검색 결과가 없습니다
            </div>
          )}
        </div>
      )}

      {/* 인원 추가 모달 */}
      {showAdd && (
        <AddMemberModal
          onClose={() => setShowAdd(false)}
          onAdd={(name, dept) => addMember(name, dept)}
        />
      )}
    </div>
  );
}

function StatCard({
  label, value, unit, tone, sub, highlight,
}: {
  label: string; value: number; unit: string;
  tone: 'indigo' | 'emerald' | 'orange' | 'gray';
  sub?: string; highlight?: boolean;
}) {
  const tones = {
    indigo:  'border-indigo-500  text-indigo-700',
    emerald: 'border-emerald-500 text-emerald-700',
    orange:  'border-orange-500  text-orange-700',
    gray:    'border-gray-400    text-gray-600',
  };
  return (
    <div className={`bg-white border-l-4 ${tones[tone]} rounded-lg shadow-sm p-4 ${highlight ? 'ring-1 ring-indigo-100' : ''}`}>
      <div className="text-xs text-gray-500 mb-1 font-medium">{label}</div>
      <div className="flex items-baseline gap-1">
        <span className={`text-3xl font-bold ${tones[tone]}`}>{value}</span>
        <span className="text-xs text-gray-500">{unit}</span>
        {sub && <span className="ml-auto text-xs text-gray-500">{sub}</span>}
      </div>
    </div>
  );
}

function AddMemberModal({
  onClose, onAdd,
}: { onClose: () => void; onAdd: (name: string, dept: string) => Promise<void> }) {
  const [name, setName] = useState('');
  const [dept, setDept] = useState('');
  const [bulk, setBulk] = useState('');
  const [tab, setTab] = useState<'single' | 'bulk'>('single');
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    if (tab === 'single') {
      if (!name.trim()) return;
      setSaving(true);
      try {
        await onAdd(name, dept);
        setName('');
      } finally { setSaving(false); }
    } else {
      const lines = bulk.split('\n').map((l) => l.trim()).filter(Boolean);
      if (lines.length === 0) return;
      setSaving(true);
      try {
        for (const line of lines) {
          // "이름,부서" or "이름\t부서" or just "이름"
          const parts = line.split(/[,\t]/).map((s) => s.trim());
          await onAdd(parts[0], parts[1] || '');
        }
        setBulk('');
        alert(`${lines.length}명 추가됨`);
        onClose();
      } finally { setSaving(false); }
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-md overflow-hidden">
        <div className="px-5 py-4 border-b bg-gradient-to-r from-blue-50 to-indigo-50 flex items-center justify-between">
          <h3 className="font-bold text-gray-800">인원 추가</h3>
          <button onClick={onClose} className="w-7 h-7 rounded-full hover:bg-gray-200 text-gray-500">×</button>
        </div>
        <div className="px-5 pt-4 flex gap-1 border-b">
          <button
            onClick={() => setTab('single')}
            className={`px-3 py-2 text-sm font-medium border-b-2 ${tab === 'single' ? 'border-blue-600 text-blue-700' : 'border-transparent text-gray-500'}`}
          >한 명 추가</button>
          <button
            onClick={() => setTab('bulk')}
            className={`px-3 py-2 text-sm font-medium border-b-2 ${tab === 'bulk' ? 'border-blue-600 text-blue-700' : 'border-transparent text-gray-500'}`}
          >여러 명 추가</button>
        </div>
        <div className="p-5 space-y-3">
          {tab === 'single' ? (
            <>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">이름</label>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && submit()}
                  placeholder="홍길동"
                  className="w-full border rounded-md px-3 py-2 text-sm"
                  autoFocus
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">부서/파트 (선택)</label>
                <input
                  value={dept}
                  onChange={(e) => setDept(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && submit()}
                  placeholder="예: 1호기, 외포장, 사무실"
                  className="w-full border rounded-md px-3 py-2 text-sm"
                />
              </div>
            </>
          ) : (
            <>
              <div className="text-xs text-gray-500">한 줄에 한 명씩 입력. 부서는 콤마(,)나 탭으로 구분</div>
              <textarea
                value={bulk}
                onChange={(e) => setBulk(e.target.value)}
                placeholder={"홍길동, 1호기\n김철수, 1호기\n이영희, 외포장"}
                className="w-full h-48 border rounded-md p-2 text-sm font-mono"
              />
            </>
          )}
        </div>
        <div className="px-5 py-3 border-t bg-slate-50 flex items-center gap-2">
          <button onClick={onClose} className="px-3 py-2 border rounded text-sm font-medium hover:bg-gray-100">취소</button>
          <button
            onClick={submit}
            disabled={saving || (tab === 'single' ? !name.trim() : !bulk.trim())}
            className="ml-auto px-5 py-2 bg-blue-600 text-white rounded font-medium hover:bg-blue-700 disabled:bg-gray-300 disabled:cursor-not-allowed"
          >
            {saving ? '저장중...' : '추가'}
          </button>
        </div>
      </div>
    </div>
  );
}
