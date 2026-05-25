import { useEffect, useMemo, useRef, useState } from 'react';
import { addDoc, collection, deleteDoc, doc, getDoc, onSnapshot, setDoc, updateDoc } from 'firebase/firestore';
import { db } from '../firebase';
import { todayKey } from '../lib/dateUtil';
import { loadViewDate, saveViewDate } from '../lib/viewDate';
import type { AttendanceRecord, AttendanceStatus, Member } from '../types';
import { ATTENDANCE_STATUSES } from '../types';
import { isOnLeave, getStatuses, effectiveStatuses, formatStatusLabel, leaveDaysFromStatuses } from '../lib/attendance';

const STATUS_COLOR: Record<AttendanceStatus, { chip: string; soft: string; text: string; border: string }> = {
  출근:    { chip: 'bg-emerald-500', soft: 'bg-emerald-50', text: 'text-emerald-700', border: 'border-emerald-300' },
  연차:    { chip: 'bg-orange-500',  soft: 'bg-orange-50',  text: 'text-orange-700',  border: 'border-orange-300' },
  반차:    { chip: 'bg-amber-500',   soft: 'bg-amber-50',   text: 'text-amber-700',   border: 'border-amber-300' },
  반반차:  { chip: 'bg-yellow-500',  soft: 'bg-yellow-50',  text: 'text-yellow-700',  border: 'border-yellow-300' },
  결혼반차: { chip: 'bg-pink-500',    soft: 'bg-pink-50',    text: 'text-pink-700',    border: 'border-pink-300' },
  병가:    { chip: 'bg-red-500',     soft: 'bg-red-50',     text: 'text-red-700',     border: 'border-red-300' },
  경조사:  { chip: 'bg-violet-500',  soft: 'bg-violet-50',  text: 'text-violet-700',  border: 'border-violet-300' },
  휴무:    { chip: 'bg-gray-400',    soft: 'bg-gray-100',   text: 'text-gray-600',    border: 'border-gray-300' },
};

/** 근태현황표용 파트 정의 (생산동 인원 현황 대상) */
const PART_GROUPS: string[] = [
  '실장&파트장',
  '전처리',
  '배합',
  '조리',
  '내포장',
  '외포장',
  'OP',
  '세정실',
  'QC',
  'AR(일용직)',
];
/** 휴직 파트는 별도 행으로 표시 (소계 제외) */
const LEAVE_PART = '휴직(육아,병가)';

/** dept 값을 파트 그룹에 매칭. 부분문자열·괄호·공백 무시. */
function matchPart(dept: string | undefined): string | null {
  if (!dept) return null;
  const norm = (s: string) => s.toLowerCase().replace(/[\s()]/g, '');
  const d = norm(dept);
  for (const p of PART_GROUPS) {
    const pn = norm(p);
    if (d === pn || d.includes(pn) || pn.includes(d)) return p;
  }
  return null;
}

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
  const [leaveTarget, setLeaveTarget] = useState<Member | null>(null);
  const [showTable, setShowTable] = useState(false);
  const [openStatusFor, setOpenStatusFor] = useState<string | null>(null);
  const [popoverPos, setPopoverPos] = useState<{ x: number; y: number; width: number; mobile: boolean } | null>(null);

  // 팝오버 외부 클릭 시 닫기
  useEffect(() => {
    if (!openStatusFor) return;
    const handler = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (!t.closest('[data-status-popover]') && !t.closest('[data-status-trigger]')) {
        setOpenStatusFor(null);
        setPopoverPos(null);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [openStatusFor]);

  const openStatusPopover = (e: React.MouseEvent<HTMLButtonElement>, mid: string) => {
    if (openStatusFor === mid) {
      setOpenStatusFor(null); setPopoverPos(null); return;
    }
    const r = e.currentTarget.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const mobile = vw < 640;
    if (mobile) {
      // 모바일: 중앙에 띄움 (어디서 눌러도 시야 중앙)
      setPopoverPos({ x: 0, y: 0, width: vw, mobile: true });
    } else {
      const estHeight = 380; // 팝오버 예상 높이
      let y = r.bottom + 4;
      // 아래로 공간 부족하면 위쪽에 띄움
      if (y + estHeight > vh) y = Math.max(8, r.top - estHeight - 4);
      // 좌우 화면 밖 방지
      const width = Math.max(220, r.width);
      let x = r.left;
      if (x + width > vw - 8) x = vw - width - 8;
      if (x < 8) x = 8;
      setPopoverPos({ x, y, width, mobile: false });
    }
    setOpenStatusFor(mid);
  };

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
    // 각 상태가 등장한 멤버 수 (한 사람이 여러 상태면 각각 +1)
    const breakdown: Record<AttendanceStatus, number> = {
      출근: 0, 연차: 0, 반차: 0, 반반차: 0, 결혼반차: 0, 병가: 0, 경조사: 0, 휴무: 0,
    };
    let onLeaveN = 0, presentN = 0, restN = 0, leaveDays = 0;
    members.forEach((m) => {
      if (isOnLeave(m, date)) { onLeaveN++; return; }
      const statuses = effectiveStatuses(records[m.id], date);
      if (statuses.length === 0 || (statuses.length === 1 && statuses[0] === '출근')) {
        presentN++; breakdown.출근++;
        return;
      }
      if (statuses.includes('휴무')) restN++;
      else leaveDays += leaveDaysFromStatuses(statuses);
      statuses.forEach((s) => { breakdown[s]++; });
    });
    const leaveN = totalN - onLeaveN - presentN - restN; // 연차/반차/결혼반차/병가/경조사 (인원수)
    const workforceN = totalN - onLeaveN - restN;
    return { totalN, presentN, leaveN, restN, onLeaveN, workforceN, leaveDays, breakdown };
  }, [members, records, date]);

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

  const setStatuses = async (m: Member, statuses: AttendanceStatus[]) => {
    if (statuses.length === 0) {
      await deleteDoc(doc(db, 'attendance', date, 'records', m.id)).catch(() => {});
      return;
    }
    await setDoc(doc(db, 'attendance', date, 'records', m.id), {
      memberId: m.id, name: m.name,
      statuses,
      status: statuses[0],  // 구버전 호환
      date,
    });
  };

  const toggleStatus = async (m: Member, s: AttendanceStatus) => {
    const current = getStatuses(records[m.id]);
    let next: AttendanceStatus[];
    if (current.includes(s)) {
      next = current.filter((x) => x !== s);
    } else {
      // 휴무·출근은 단독 (다른 휴가 상태와 배타)
      if (s === '휴무' || s === '출근') next = [s];
      else next = [...current.filter((x) => x !== '휴무' && x !== '출근'), s];
    }
    await setStatuses(m, next);
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

  const setLeave = async (m: Member, leaveFrom: string | null, leaveTo: string | null) => {
    const update: Partial<Member> = {};
    update.leaveFrom = leaveFrom || undefined;
    update.leaveTo = leaveTo || undefined;
    // Firestore: undefined 필드는 제거하기 위해 deleteField 사용 대신 빈 문자열로
    await updateDoc(doc(db, 'members', m.id), {
      leaveFrom: leaveFrom || null,
      leaveTo: leaveTo || null,
    });
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
        <button
          onClick={() => setShowTable(true)}
          className="px-3 py-1.5 text-xs rounded border border-emerald-400 text-emerald-700 bg-emerald-50 hover:bg-emerald-100 font-semibold"
          title="근태현황표"
        >📋 표</button>
        <div className="ml-auto text-xs text-gray-500">
          출근 분모 (휴직·휴무 제외) <span className="font-bold text-gray-800 ml-1">{counts.workforceN}명</span>
        </div>
      </div>

      {/* 카운트 카드 */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        <StatCard label="총원" value={counts.totalN} unit="명" tone="indigo" highlight />
        <StatCard label="출근" value={counts.presentN} unit="명" tone="emerald" sub={counts.workforceN > 0 ? `${((counts.presentN / counts.workforceN) * 100).toFixed(1)}%` : ''} />
        <StatCard label="연차/반차 등" value={counts.leaveN} unit="명" tone="orange" />
        <StatCard label="휴무" value={counts.restN} unit="명" tone="gray" />
        <StatCard label="휴직" value={counts.onLeaveN} unit="명" tone="zinc" />
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
            <div className="flex items-center justify-between">
              <span className="flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-zinc-500" />
                <span className="text-gray-600">휴직</span>
              </span>
              <span className="font-bold text-gray-800">{counts.onLeaveN}</span>
            </div>
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
                  const onLeave = isOnLeave(m, date);
                  const statuses = effectiveStatuses(records[m.id], date);
                  const primary: AttendanceStatus = statuses[0] || '출근';
                  const color = STATUS_COLOR[primary];
                  const label = formatStatusLabel(statuses);
                  const isEdit = editing === m.id;
                  const cardBg = onLeave ? 'bg-zinc-100' : color.soft;
                  return (
                    <div key={m.id} className={`p-3 ${cardBg} relative group`}>
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
                              <div className="font-bold text-gray-900 truncate flex items-center gap-1">
                                {m.name}
                              </div>
                              {m.dept && <div className="text-[10px] text-gray-500 truncate">{m.dept}</div>}
                            </div>
                            <div className="opacity-0 group-hover:opacity-100 transition flex gap-0.5 -mt-1">
                              <button
                                onClick={() => setLeaveTarget(m)}
                                className={`text-xs px-1 ${onLeave ? 'text-zinc-700 font-bold' : 'text-gray-400 hover:text-zinc-700'}`}
                                title="휴직 관리"
                              >💼</button>
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
                          {onLeave ? (
                            <button
                              onClick={() => setLeaveTarget(m)}
                              className="w-full px-2 py-1.5 rounded border-2 border-zinc-400 text-zinc-700 bg-zinc-50 font-semibold text-sm hover:bg-zinc-100 text-left"
                            >
                              <div className="flex items-center justify-between">
                                <span>💼 휴직 중</span>
                                <span className="text-[10px] text-zinc-500 font-normal">관리</span>
                              </div>
                              <div className="text-[10px] text-zinc-500 font-normal mt-0.5">
                                {m.leaveFrom}{m.leaveTo ? ` ~ ${m.leaveTo}` : ' ~'}
                              </div>
                            </button>
                          ) : (
                            <div className="relative">
                              <button
                                data-status-trigger
                                onClick={(e) => openStatusPopover(e, m.id)}
                                className={`w-full px-2 py-1.5 rounded border-2 ${color.border} ${color.text} bg-white font-semibold text-sm cursor-pointer focus:outline-none focus:ring-2 focus:ring-blue-200 text-left flex items-center justify-between gap-1`}
                              >
                                <span className="truncate">{label}</span>
                                <span className="text-xs flex-shrink-0">▼</span>
                              </button>
                            </div>
                          )}
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

      {/* 근태현황표 */}
      {showTable && (
        <AttendanceTableModal
          date={date}
          members={members}
          records={records}
          onClose={() => setShowTable(false)}
        />
      )}

      {/* 인원 추가 모달 */}
      {showAdd && (
        <AddMemberModal
          onClose={() => setShowAdd(false)}
          onAdd={(name, dept) => addMember(name, dept)}
        />
      )}

      {/* 휴직 관리 모달 */}
      {leaveTarget && (
        <LeaveModal
          member={leaveTarget}
          today={date}
          onClose={() => setLeaveTarget(null)}
          onApply={async (from, to) => {
            await setLeave(leaveTarget, from, to);
            setLeaveTarget(null);
          }}
          onClear={async () => {
            await setLeave(leaveTarget, null, null);
            setLeaveTarget(null);
          }}
        />
      )}

      {/* 상태 팝오버 (모바일=중앙 모달 / PC=fixed 위치) */}
      {openStatusFor && popoverPos && (() => {
        const m = members.find((mm) => mm.id === openStatusFor);
        if (!m) return null;
        const statuses = getStatuses(records[m.id]);
        const close = () => { setOpenStatusFor(null); setPopoverPos(null); };
        const body = (
          <>
            <div className="px-2 py-1.5 text-xs font-bold text-gray-700 border-b mb-1 flex items-center justify-between">
              <span>{m.name} · 상태 선택</span>
              {popoverPos.mobile && (
                <button onClick={close} className="w-6 h-6 rounded-full hover:bg-gray-200 text-gray-500">×</button>
              )}
            </div>
            {ATTENDANCE_STATUSES.map((s) => {
              const checked = statuses.includes(s);
              const stColor = STATUS_COLOR[s];
              return (
                <label key={s} className={`flex items-center gap-2 px-2 py-2.5 rounded cursor-pointer hover:bg-gray-50 ${checked ? stColor.soft : ''}`}>
                  <input type="checkbox" checked={checked} onChange={() => toggleStatus(m, s)} className="w-4 h-4" />
                  <span className={`w-2 h-2 rounded-full ${stColor.chip}`} />
                  <span className={`text-sm ${checked ? `${stColor.text} font-semibold` : 'text-gray-700'}`}>{s}</span>
                </label>
              );
            })}
            <div className="border-t pt-2 mt-1 flex items-center justify-between text-[11px] px-1 gap-2">
              {statuses.length > 0 ? (
                <button onClick={() => setStatuses(m, [])} className="text-blue-600 hover:underline">→ 기본값(평일=출근/일요일=휴무)</button>
              ) : (() => {
                const [yy, mm, dd] = date.split('-').map(Number);
                const dow = new Date(yy, mm - 1, dd).getDay();
                return <span className="text-gray-400">체크 없으면 {dow === 0 ? '휴무' : '출근'}</span>;
              })()}
              <button onClick={close} className="px-3 py-1.5 rounded bg-blue-600 text-white text-xs font-semibold hover:bg-blue-700">완료</button>
            </div>
          </>
        );
        if (popoverPos.mobile) {
          return (
            <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/40" onClick={close}>
              <div data-status-popover onClick={(e) => e.stopPropagation()} className="bg-white border rounded-xl shadow-2xl p-3 w-full max-w-xs space-y-0.5">
                {body}
              </div>
            </div>
          );
        }
        return (
          <div
            data-status-popover
            style={{ position: 'fixed', left: popoverPos.x, top: popoverPos.y, width: popoverPos.width, zIndex: 60 }}
            className="bg-white border rounded-lg shadow-2xl p-2 space-y-0.5"
          >
            {body}
          </div>
        );
      })()}
    </div>
  );
}

function StatCard({
  label, value, unit, tone, sub, highlight,
}: {
  label: string; value: number; unit: string;
  tone: 'indigo' | 'emerald' | 'orange' | 'gray' | 'zinc';
  sub?: string; highlight?: boolean;
}) {
  const tones = {
    indigo:  'border-indigo-500  text-indigo-700',
    emerald: 'border-emerald-500 text-emerald-700',
    orange:  'border-orange-500  text-orange-700',
    gray:    'border-gray-400    text-gray-600',
    zinc:    'border-zinc-500    text-zinc-700',
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

function LeaveModal({
  member, today, onClose, onApply, onClear,
}: {
  member: Member;
  today: string;
  onClose: () => void;
  onApply: (from: string, to: string | null) => Promise<void>;
  onClear: () => Promise<void>;
}) {
  const isOn = !!member.leaveFrom && (!member.leaveTo || member.leaveTo >= today);
  const [from, setFrom] = useState(member.leaveFrom || today);
  const [to, setTo] = useState(member.leaveTo || '');
  const [saving, setSaving] = useState(false);

  const apply = async () => {
    if (!from) return;
    if (to && to < from) { alert('휴직 종료일은 시작일 이후여야 합니다'); return; }
    setSaving(true);
    try { await onApply(from, to || null); }
    finally { setSaving(false); }
  };

  const clear = async () => {
    if (!confirm(`'${member.name}'의 휴직을 완전히 해제할까요?`)) return;
    setSaving(true);
    try { await onClear(); }
    finally { setSaving(false); }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-md overflow-hidden">
        <div className="px-5 py-4 border-b bg-gradient-to-r from-zinc-50 to-slate-50 flex items-center justify-between">
          <div>
            <h3 className="font-bold text-gray-800 flex items-center gap-2">💼 휴직 관리</h3>
            <div className="text-xs text-gray-500 mt-0.5">{member.name}{member.dept && ` · ${member.dept}`}</div>
          </div>
          <button onClick={onClose} className="w-7 h-7 rounded-full hover:bg-gray-200 text-gray-500">×</button>
        </div>
        <div className="p-5 space-y-4">
          {isOn ? (
            <div className="px-3 py-2 bg-zinc-100 border border-zinc-300 rounded text-sm text-zinc-700">
              현재 <b>휴직 중</b> ({member.leaveFrom}{member.leaveTo ? ` ~ ${member.leaveTo}` : ' ~ 현재'})
            </div>
          ) : (
            <div className="px-3 py-2 bg-emerald-50 border border-emerald-200 rounded text-sm text-emerald-700">
              현재 휴직 상태가 아닙니다
            </div>
          )}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">휴직 시작일</label>
              <input
                type="date"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
                className="w-full border rounded-md px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">휴직 종료일 <span className="text-gray-400">(선택)</span></label>
              <input
                type="date"
                value={to}
                onChange={(e) => setTo(e.target.value)}
                className="w-full border rounded-md px-3 py-2 text-sm"
              />
            </div>
          </div>
          <p className="text-[11px] text-gray-500 leading-relaxed">
            · 종료일을 비우면 무기한 휴직으로 등록됩니다.<br />
            · 등록 후 해당 기간 동안 출근/연차/휴무 카운트에서 자동으로 제외됩니다.<br />
            · 종료일을 설정하면 그날까지(포함) 휴직으로 처리되고 다음 날부터 자동 복귀합니다.
          </p>
        </div>
        <div className="px-5 py-3 border-t bg-slate-50 flex items-center gap-2">
          {isOn && (
            <button
              onClick={clear}
              disabled={saving}
              className="px-3 py-2 border border-red-300 text-red-700 rounded text-sm font-medium hover:bg-red-50 disabled:opacity-50"
            >완전 해제</button>
          )}
          <button onClick={onClose} className="ml-auto px-3 py-2 border rounded text-sm font-medium hover:bg-gray-100">취소</button>
          <button
            onClick={apply}
            disabled={saving || !from}
            className="px-5 py-2 bg-zinc-700 text-white rounded font-medium hover:bg-zinc-800 disabled:bg-gray-300 disabled:cursor-not-allowed"
          >
            {saving ? '저장중...' : (isOn ? '변경 적용' : '휴직 등록')}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ===================== 근태현황표 ===================== */

interface AttendanceMeta {
  needHeads?: Record<string, number>;
  arTotal?: number;
  arPresent?: number;
  arNames?: string;
  note?: string;
}

function AttendanceTableModal({
  date, members, records, onClose,
}: {
  date: string;
  members: Member[];
  records: Record<string, AttendanceRecord>;
  onClose: () => void;
}) {
  const [meta, setMeta] = useState<AttendanceMeta>({ needHeads: {}, note: '' });
  const [defaultNeed, setDefaultNeed] = useState<Record<string, number>>({});
  const [loaded, setLoaded] = useState(false);
  const dayTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const monthTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const month = date.slice(0, 7); // YYYY-MM

  // 일자 메타 + 월 특이사항 + 기본 필요인원 로드
  useEffect(() => {
    let alive = true;
    (async () => {
      const [daySnap, monthSnap, defSnap] = await Promise.all([
        getDoc(doc(db, 'attendanceMeta', date)),
        getDoc(doc(db, 'attendanceMeta', `_month_${month}`)),
        getDoc(doc(db, 'attendanceMeta', '_default')),
      ]);
      if (!alive) return;
      const def = (defSnap.data() as { needHeads?: Record<string, number> } | undefined)?.needHeads || {};
      setDefaultNeed(def);
      const dayData = (daySnap.data() as AttendanceMeta | undefined) || {};
      const monthData = (monthSnap.data() as { note?: string } | undefined) || {};
      setMeta({
        needHeads: dayData.needHeads || { ...def },
        arTotal: dayData.arTotal ?? 0,
        arPresent: dayData.arPresent ?? 0,
        arNames: dayData.arNames || '',
        note: monthData.note || '',
      });
      setLoaded(true);
    })();
    return () => { alive = false; };
  }, [date, month]);

  // 일자 메타 저장 (note 제외)
  const persistDay = (next: AttendanceMeta) => {
    setMeta(next);
    if (dayTimer.current) clearTimeout(dayTimer.current);
    dayTimer.current = setTimeout(() => {
      setDoc(doc(db, 'attendanceMeta', date), {
        needHeads: next.needHeads || {},
        arTotal: next.arTotal ?? 0,
        arPresent: next.arPresent ?? 0,
        arNames: next.arNames || '',
        date,
      }, { merge: true }).catch(() => {});
    }, 400);
  };

  // 월 특이사항 저장
  const persistMonthNote = (note: string) => {
    setMeta((prev) => ({ ...prev, note }));
    if (monthTimer.current) clearTimeout(monthTimer.current);
    monthTimer.current = setTimeout(() => {
      setDoc(doc(db, 'attendanceMeta', `_month_${month}`), {
        note,
        month,
      }, { merge: true }).catch(() => {});
    }, 400);
  };

  const setNeed = (part: string, v: number) => {
    persistDay({ ...meta, needHeads: { ...(meta.needHeads || {}), [part]: v } });
  };
  const setArTotal = (v: number) => persistDay({ ...meta, arTotal: v });
  const setArPresent = (v: number) => persistDay({ ...meta, arPresent: v });
  const setArNames = (v: string) => persistDay({ ...meta, arNames: v });
  const setNote = (v: string) => persistMonthNote(v);

  const saveAsDefault = async () => {
    await setDoc(doc(db, 'attendanceMeta', '_default'), {
      needHeads: meta.needHeads || {},
    }, { merge: true });
    setDefaultNeed(meta.needHeads || {});
    alert('현재 필요 인원이 기본값으로 저장되었습니다.');
  };

  // 일요일이면 출근자 표시, 평일이면 결근자(연차/반차/반반차/병가/경조사/결혼반차) 표시
  const [y, mo, d] = date.split('-').map(Number);
  const dow = new Date(y, mo - 1, d).getDay(); // 0=일
  const isSunday = dow === 0;

  // 파트별 분류
  const rows = useMemo(() => {
    const buckets: Record<string, Member[]> = {};
    PART_GROUPS.forEach((p) => { buckets[p] = []; });
    const leaveBucket: Member[] = [];
    members.forEach((m) => {
      if (isOnLeave(m, date)) { leaveBucket.push(m); return; }
      const p = matchPart(m.dept);
      if (p) buckets[p].push(m);
    });
    return { buckets, leaveBucket };
  }, [members, date]);

  type PartRow = {
    part: string;
    total: number;
    연차: number;
    반차: number;
    반반차: number;
    휴무: number;
    출근: number;
    names: string[]; // 일요일=출근자, 평일=결근자
    otherLeave: number; // 병가/경조사/결혼반차 등
  };

  const partRows: PartRow[] = useMemo(() => {
    return PART_GROUPS.map((part) => {
      const list = rows.buckets[part];
      const row: PartRow = {
        part, total: list.length,
        연차: 0, 반차: 0, 반반차: 0, 휴무: 0, 출근: 0,
        names: [], otherLeave: 0,
      };
      const present: string[] = [];
      const absent: string[] = [];
      list.forEach((m) => {
        const statuses = effectiveStatuses(records[m.id], date);
        if (statuses.length === 0 || (statuses.length === 1 && statuses[0] === '출근')) { row.출근++; present.push(m.name); return; }
        if (statuses.includes('휴무')) {
          row.휴무++;
          if (!isSunday) absent.push(`${m.name}(휴무)`);
          return;
        }
        let counted = false;
        if (statuses.includes('연차')) { row.연차++; counted = true; }
        if (statuses.includes('반차')) { row.반차++; counted = true; }
        if (statuses.includes('반반차')) { row.반반차++; counted = true; }
        const others = statuses.filter((s) => !['연차','반차','반반차','휴무','출근'].includes(s));
        if (others.length) { row.otherLeave += others.length; counted = true; }
        // 반차/반반차는 부분 출근 → 출근 인원에도 포함
        if (statuses.includes('반차') || statuses.includes('반반차')) {
          row.출근++; present.push(m.name);
        }
        if (counted) {
          const label = statuses.filter((s) => s !== '출근').join('+');
          absent.push(`${m.name}(${label})`);
        }
      });
      row.names = isSunday ? present : absent;
      // AR(일용직)은 수동 입력값으로 덮어쓰기
      if (part === 'AR(일용직)') {
        row.total = meta.arTotal ?? 0;
        row.출근 = meta.arPresent ?? 0;
      }
      return row;
    });
  }, [rows, records, isSunday, date, meta.arTotal, meta.arPresent]);

  // 생산동 인원 현황 (휴직 제외, 파트 합산)
  const totals = useMemo(() => {
    const totalHeads = partRows.reduce((s, r) => s + r.total, 0);
    const presentHeads = partRows.reduce((s, r) => s + r.출근, 0);
    const need = partRows.reduce((s, r) => s + (meta.needHeads?.[r.part] || 0), 0);
    return { totalHeads, presentHeads, need };
  }, [partRows, meta.needHeads]);

  // 총 원 분류: 실장 / 파트장 / QC / 생산(나머지) — 휴직자 포함
  const totalsBreakdown = useMemo(() => {
    const norm = (s: string) => (s || '').toLowerCase().replace(/[\s()]/g, '');
    let 실장 = 0, 파트장 = 0, qc = 0, 생산 = 0;
    members.forEach((m) => {
      const d = norm(m.dept || '');
      if (d.includes('실장')) 실장++;
      else if (d.includes('파트장')) 파트장++;
      else if (d === 'qc') qc++;
      else if (matchPart(m.dept)) 생산++;
    });
    return [
      { label: '실장', value: 실장 },
      { label: '파트장', value: 파트장 },
      { label: '생산', value: 생산 },
      { label: 'QC', value: qc },
    ].filter((b) => b.value > 0);
  }, [members]);

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-6xl h-[92vh] overflow-hidden flex flex-col">
        <div className="px-6 py-4 border-b flex items-center justify-between bg-gradient-to-r from-emerald-50 to-teal-50">
          <div>
            <h3 className="text-lg font-bold text-gray-800">📋 근태현황표</h3>
            <div className="text-xs text-gray-500 mt-0.5">{dateLabel(date)} · {isSunday ? '일요일 — 출근자 표시' : '평일 — 결근자 표시'}</div>
          </div>
          <button onClick={onClose} className="w-8 h-8 rounded-full hover:bg-gray-200 text-gray-500 text-lg">×</button>
        </div>

        {!loaded ? (
          <div className="flex-1 flex items-center justify-center text-gray-400 text-sm">불러오는 중...</div>
        ) : (
        <div className="flex-1 overflow-y-auto p-6 space-y-6 bg-white">
          {/* === 근태현황 메인 표 === */}
          <div>
            <table className="w-full border-collapse text-sm" style={{ borderColor: '#999' }}>
              <thead>
                <tr>
                  <th colSpan={9} className="border border-gray-500 bg-amber-50 text-center font-bold py-2 text-base">
                    {date} 근태현황
                  </th>
                </tr>
                <tr className="bg-amber-100">
                  <th className="border border-gray-500 px-2 py-1.5 w-16">구분</th>
                  <th className="border border-gray-500 px-2 py-1.5 w-32">파트</th>
                  <th className="border border-gray-500 px-2 py-1.5 w-14">총원</th>
                  <th className="border border-gray-500 px-2 py-1.5 w-14">연차</th>
                  <th className="border border-gray-500 px-2 py-1.5 w-14">반차</th>
                  <th className="border border-gray-500 px-2 py-1.5 w-14">반반차</th>
                  <th className="border border-gray-500 px-2 py-1.5 w-14">휴무</th>
                  <th className="border border-gray-500 px-2 py-1.5 w-14">출근</th>
                  <th className="border border-gray-500 px-2 py-1.5"></th>
                </tr>
              </thead>
              <tbody>
                {partRows.map((r, idx) => {
                  const isLead = r.part === '실장&파트장';
                  const isAR = r.part === 'AR(일용직)';
                  return (
                    <tr key={r.part} className={isLead ? 'bg-gray-100' : 'bg-white'}>
                      {idx === 0 && (
                        <td
                          rowSpan={partRows.length}
                          className="border border-gray-500 text-center font-bold align-middle bg-white"
                        >생산</td>
                      )}
                      <td className="border border-gray-500 px-2 py-1.5 text-center font-semibold">{r.part}</td>
                      <td className="border border-gray-500 px-1 py-0.5 text-center font-bold">
                        {isAR ? (
                          <input
                            type="number"
                            value={meta.arTotal ?? 0}
                            onChange={(e) => setArTotal(Number(e.target.value) || 0)}
                            className="w-12 border rounded px-1 py-0.5 text-center font-bold"
                          />
                        ) : (r.total === 0 ? 0 : r.total)}
                      </td>
                      <td className="border border-gray-500 px-2 py-1.5 text-center text-blue-700 font-semibold">{r.연차 || ''}</td>
                      <td className="border border-gray-500 px-2 py-1.5 text-center text-blue-700 font-semibold">{r.반차 || ''}</td>
                      <td className="border border-gray-500 px-2 py-1.5 text-center text-blue-700 font-semibold">{r.반반차 || ''}</td>
                      <td className="border border-gray-500 px-2 py-1.5 text-center text-blue-700 font-semibold">{r.휴무 || ''}</td>
                      <td className="border border-gray-500 px-1 py-0.5 text-center text-blue-700 font-bold">
                        {isAR ? (
                          <input
                            type="number"
                            value={meta.arPresent ?? 0}
                            onChange={(e) => setArPresent(Number(e.target.value) || 0)}
                            className="w-12 border rounded px-1 py-0.5 text-center font-bold text-blue-700"
                          />
                        ) : (r.출근 === 0 ? 0 : r.출근)}
                      </td>
                      <td className="border border-gray-500 px-1 py-0.5 text-xs text-gray-700">
                        {isAR ? (
                          <input
                            type="text"
                            value={meta.arNames || ''}
                            onChange={(e) => setArNames(e.target.value)}
                            className="w-full border-0 bg-transparent px-2 py-1 text-xs focus:outline-none focus:bg-yellow-50"
                          />
                        ) : r.names.join(', ')}
                      </td>
                    </tr>
                  );
                })}
                {/* 휴직 행 */}
                <tr style={{ background: '#fce4e4' }}>
                  <td className="border border-gray-500 px-2 py-1.5 text-center font-semibold" colSpan={2}>{LEAVE_PART}</td>
                  <td className="border border-gray-500 px-2 py-1.5 text-center font-bold">{rows.leaveBucket.length || (rows.leaveBucket.length === 0 ? 0 : '')}</td>
                  <td className="border border-gray-500 px-2 py-1.5"></td>
                  <td className="border border-gray-500 px-2 py-1.5"></td>
                  <td className="border border-gray-500 px-2 py-1.5"></td>
                  <td className="border border-gray-500 px-2 py-1.5 text-center text-blue-700 font-semibold">{rows.leaveBucket.length || ''}</td>
                  <td className="border border-gray-500 px-2 py-1.5 text-center text-blue-700 font-bold">0</td>
                  <td className="border border-gray-500 px-2 py-1.5 text-xs text-gray-700">{rows.leaveBucket.map((m) => m.name).join(', ')}</td>
                </tr>
                {/* 합계 행 */}
                <tr className="bg-yellow-200 font-bold">
                  <td className="border border-gray-500 px-2 py-1.5 text-center" colSpan={2}>합 계</td>
                  <td className="border border-gray-500 px-2 py-1.5 text-center">{totals.totalHeads + rows.leaveBucket.length}</td>
                  <td className="border border-gray-500 px-2 py-1.5 text-center">{partRows.reduce((s, r) => s + r.연차, 0)}</td>
                  <td className="border border-gray-500 px-2 py-1.5 text-center">{partRows.reduce((s, r) => s + r.반차, 0)}</td>
                  <td className="border border-gray-500 px-2 py-1.5 text-center">{partRows.reduce((s, r) => s + r.반반차, 0)}</td>
                  <td className="border border-gray-500 px-2 py-1.5 text-center">{partRows.reduce((s, r) => s + r.휴무, 0) + rows.leaveBucket.length}</td>
                  <td className="border border-gray-500 px-2 py-1.5 text-center">{totals.presentHeads}</td>
                  <td className="border border-gray-500 px-2 py-1.5"></td>
                </tr>
              </tbody>
            </table>
          </div>

          {/* === 하단 3구역: 생산동 인원 현황 / 총원 / 특이사항 === */}
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
            {/* 생산동 인원 현황 */}
            <div className="lg:col-span-3">
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr>
                    <th colSpan={2} className="border border-gray-500 bg-amber-100 text-center py-1.5 font-bold">
                      생산동 인원 현황
                    </th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td className="border border-gray-500 px-3 py-1.5 bg-yellow-100 font-semibold">필요 인원</td>
                    <td className="border border-gray-500 px-3 py-1 text-right">
                      <input
                        type="number"
                        value={meta.needHeads?.__total ?? ''}
                        onChange={(e) => setNeed('__total', Number(e.target.value) || 0)}
                        placeholder={String(defaultNeed.__total ?? '')}
                        className="w-20 border rounded px-2 py-0.5 text-right font-bold"
                      />
                    </td>
                  </tr>
                  <tr>
                    <td className="border border-gray-500 px-3 py-1.5 font-semibold">총 인원</td>
                    <td className="border border-gray-500 px-3 py-1.5 text-right font-bold">{totals.totalHeads + rows.leaveBucket.length}</td>
                  </tr>
                  <tr>
                    <td className="border border-gray-500 px-3 py-1.5 text-red-600 font-bold">출근인원</td>
                    <td className="border border-gray-500 px-3 py-1.5 text-right text-red-600 font-bold">{totals.presentHeads}</td>
                  </tr>
                </tbody>
              </table>
              <button
                onClick={saveAsDefault}
                className="mt-2 text-[11px] px-2 py-1 border border-blue-300 text-blue-700 rounded hover:bg-blue-50"
                title="현재 필요 인원을 기본값으로 저장"
              >현재값 기본값 저장</button>
            </div>

            {/* 총원 (자동 분류) */}
            <div className="lg:col-span-4">
              <table className="w-full border-collapse text-sm">
                <tbody>
                  <tr>
                    <td colSpan={2} className="border border-gray-500 bg-amber-100 text-center py-1.5 font-bold">총 원</td>
                  </tr>
                  <tr>
                    <td className="border border-gray-500 bg-amber-50 text-center font-bold align-middle w-16 px-2 py-2">총<br/>원</td>
                    <td className="border border-gray-500 align-middle px-4 py-3 text-sm leading-7 bg-white">
                      {totalsBreakdown.map((b) => (
                        <div key={b.label}>{b.label} : {b.value}명</div>
                      ))}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>

            {/* 특이사항 */}
            <div className="lg:col-span-5">
              <table className="w-full border-collapse text-sm">
                <tbody>
                  <tr>
                    <td colSpan={2} className="border border-gray-500 bg-amber-100 text-center py-1.5 font-bold">특이사항 <span className="text-[10px] font-normal text-gray-500">({month} 월별)</span></td>
                  </tr>
                  <tr>
                    <td className="border border-gray-500 bg-amber-50 text-center font-bold align-middle w-16 px-2 py-2">특이<br/>사항</td>
                    <td className="border border-gray-500 bg-white p-0 align-top">
                      <textarea
                        value={meta.note || ''}
                        onChange={(e) => setNote(e.target.value)}
                        placeholder={'* 이윤미 육아휴직(~8/31)\n- 5/6 입사: 박홍관, 황티띠엣\n- 5/14 퇴사 : 조현숙'}
                        className="w-full p-3 text-sm resize-y min-h-[140px] focus:outline-none bg-white"
                      />
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>

          <div className="text-[11px] text-gray-400">
            · 파트는 인원의 부서(dept) 값으로 자동 분류됩니다. 누락된 인원이 있으면 부서명을 위 파트명에 맞춰 수정해 주세요.<br />
            · 필요 인원·특이사항은 자동 저장됩니다.
          </div>
        </div>
        )}

        <div className="border-t bg-slate-50 px-6 py-3 flex items-center justify-end">
          <button onClick={onClose} className="px-4 py-2 bg-gray-700 hover:bg-gray-800 text-white rounded text-sm font-medium">닫기</button>
        </div>
      </div>
    </div>
  );
}
