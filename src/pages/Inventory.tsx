import { useEffect, useMemo, useRef, useState } from 'react';
import { addDoc, collection, deleteDoc, doc, getDocs, onSnapshot, updateDoc } from 'firebase/firestore';
import { db } from '../firebase';
import { todayKey, effectiveTodayKey } from '../lib/dateUtil';
import { loadViewDate, saveViewDate } from '../lib/viewDate';
import type { InventoryMovement, InventoryRequest, Material } from '../types';
import { WAREHOUSES } from '../types';

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

// 비프음 (Web Audio API — 외부 파일 없이)
function playBeep() {
  try {
    const Ctx = window.AudioContext || (window as any).webkitAudioContext;
    const ctx = new Ctx();
    const make = (freq: number, start: number, dur: number) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0, ctx.currentTime + start);
      gain.gain.linearRampToValueAtTime(0.4, ctx.currentTime + start + 0.02);
      gain.gain.linearRampToValueAtTime(0, ctx.currentTime + start + dur);
      osc.connect(gain); gain.connect(ctx.destination);
      osc.start(ctx.currentTime + start);
      osc.stop(ctx.currentTime + start + dur + 0.05);
    };
    // 띵-띵-띵
    make(880, 0, 0.18);
    make(1175, 0.22, 0.18);
    make(880, 0.44, 0.25);
    setTimeout(() => ctx.close(), 1200);
  } catch {}
}

type Mv = InventoryMovement & { id: string };
type Rq = InventoryRequest & { id: string };

const NOTIFY_KEY = 'inventoryNotifyEnabled';
const LASTSEEN_KEY = 'inventoryLastSeenReq';

export default function Inventory() {
  const [date, setDate] = useState(loadViewDate);
  useEffect(() => { saveViewDate(date); }, [date]);

  // 새벽 2시 기준 자동 날짜 롤오버
  useEffect(() => {
    const tick = () => {
      const eff = effectiveTodayKey();
      if (date !== eff) setDate(eff);
    };
    const id = setInterval(tick, 60_000);
    return () => clearInterval(id);
  }, [date]);

  const [materials, setMaterials] = useState<Material[]>([]);
  const [movements, setMovements] = useState<Mv[]>([]);
  const [requests, setRequests] = useState<Rq[]>([]);
  const [selectedWh, setSelectedWh] = useState<number | 'all'>('all');
  const [showAdd, setShowAdd] = useState(false);
  const [newRequest, setNewRequest] = useState('');

  // 자재관리자 알림 (이 디바이스에만 저장)
  const [notifyEnabled, setNotifyEnabled] = useState<boolean>(() => localStorage.getItem(NOTIFY_KEY) === '1');
  const [alertItems, setAlertItems] = useState<Rq[]>([]);
  const lastSeenRef = useRef<string>(localStorage.getItem(LASTSEEN_KEY) || new Date().toISOString());
  const initialLoadRef = useRef<Set<string>>(new Set());
  const initialDoneRef = useRef<boolean>(false);
  const originalTitleRef = useRef<string>('');

  // 페이지 진입 시 현재 시각 기준으로 lastSeen 초기화 (기존 요청은 알림 안 가게)
  useEffect(() => {
    initialDoneRef.current = false;
    initialLoadRef.current = new Set();
  }, [date]);

  // 탭 제목 복원/관리
  useEffect(() => {
    if (!originalTitleRef.current) originalTitleRef.current = document.title;
    if (alertItems.length > 0) {
      document.title = `🔔 새 요청사항 (${alertItems.length})`;
    } else {
      document.title = originalTitleRef.current;
    }
    return () => { document.title = originalTitleRef.current; };
  }, [alertItems.length]);

  // 원재료 마스터는 자주 안 바뀌므로 1회 fetch
  useEffect(() => {
    getDocs(collection(db, 'materials')).then((snap) => {
      const list: Material[] = [];
      snap.forEach((d) => list.push({ ...(d.data() as Material), id: d.id }));
      list.sort((a, b) => a.name.localeCompare(b.name));
      setMaterials(list);
    }).catch(() => {});
  }, []);

  useEffect(() => {
    setMovements([]);
    return onSnapshot(collection(db, 'inventory', date, 'movements'), (snap) => {
      const list: Mv[] = [];
      snap.forEach((d) => list.push({ ...(d.data() as InventoryMovement), id: d.id }));
      list.sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));
      setMovements(list);
    });
  }, [date]);

  useEffect(() => {
    setRequests([]);
    return onSnapshot(collection(db, 'inventory', date, 'requests'), (snap) => {
      const list: Rq[] = [];
      snap.forEach((d) => list.push({ ...(d.data() as InventoryRequest), id: d.id }));
      list.sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));

      // 첫 스냅샷은 알림 무시 (기존 데이터 로드)
      if (!initialDoneRef.current) {
        list.forEach((r) => initialLoadRef.current.add(r.id));
        initialDoneRef.current = true;
        setRequests(list);
        return;
      }

      // 알림 트리거: 자재관리자 모드 + 처음 보는 신규 요청 + lastSeen 이후
      if (notifyEnabled) {
        const fresh = list.filter((r) =>
          !initialLoadRef.current.has(r.id) &&
          (!r.createdAt || r.createdAt > lastSeenRef.current)
        );
        // 이미 처리한 ID 표기
        fresh.forEach((r) => initialLoadRef.current.add(r.id));
        if (fresh.length > 0) {
          setAlertItems((prev) => {
            const existingIds = new Set(prev.map((p) => p.id));
            const merged = [...prev, ...fresh.filter((f) => !existingIds.has(f.id))];
            return merged;
          });
          playBeep();
          // OS 알림 (권한 있을 때만, 백그라운드 탭에서도 동작)
          if ('Notification' in window && Notification.permission === 'granted') {
            try {
              const n = new Notification('🔔 새 재고 요청사항', {
                body: fresh.map((f) => `· ${f.text}`).join('\n').slice(0, 200),
                tag: 'inv-req',
              });
              n.onclick = () => { window.focus(); n.close(); };
            } catch {}
          }
        }
      } else {
        // 알림 꺼져있어도 ID 추적은 해야 다음에 켰을 때 과거 항목 안 뜸
        list.forEach((r) => initialLoadRef.current.add(r.id));
      }

      setRequests(list);
    });
  }, [date, notifyEnabled]);

  const isToday = date === todayKey();

  const byWarehouse = useMemo(() => {
    const map = new Map<number, { in: Mv[]; out: Mv[] }>();
    WAREHOUSES.forEach((w) => map.set(w, { in: [], out: [] }));
    movements.forEach((mv) => {
      const bucket = map.get(mv.warehouse);
      if (!bucket) return;
      if (mv.type === '입고') bucket.in.push(mv);
      else bucket.out.push(mv);
    });
    return map;
  }, [movements]);

  const totals = useMemo(() => {
    let inC = 0, outC = 0;
    movements.forEach((mv) => { if (mv.type === '입고') inC++; else outC++; });
    return { inC, outC, total: movements.length };
  }, [movements]);

  const toggleDone = async (mv: Mv) => {
    await updateDoc(doc(db, 'inventory', date, 'movements', mv.id), { done: !mv.done });
  };
  const removeMv = async (mv: Mv) => {
    if (!confirm(`'${mv.materialName}${mv.spec ? ` ${mv.spec}` : ''}' ${mv.type} 기록을 삭제할까요?`)) return;
    await deleteDoc(doc(db, 'inventory', date, 'movements', mv.id));
  };

  const addRequest = async () => {
    if (!newRequest.trim()) return;
    await addDoc(collection(db, 'inventory', date, 'requests'), {
      text: newRequest.trim(), done: false, date, createdAt: new Date().toISOString(),
    });
    setNewRequest('');
  };
  const toggleReq = async (r: Rq) => {
    await updateDoc(doc(db, 'inventory', date, 'requests', r.id), { done: !r.done });
  };
  const removeReq = async (r: Rq) => {
    await deleteDoc(doc(db, 'inventory', date, 'requests', r.id));
  };

  const toggleNotify = async () => {
    const next = !notifyEnabled;
    if (next && 'Notification' in window && Notification.permission === 'default') {
      try { await Notification.requestPermission(); } catch {}
    }
    setNotifyEnabled(next);
    localStorage.setItem(NOTIFY_KEY, next ? '1' : '0');
    // 켜는 순간 기준점 갱신 (이미 있는 요청은 알림 X)
    const now = new Date().toISOString();
    lastSeenRef.current = now;
    localStorage.setItem(LASTSEEN_KEY, now);
    // 한번 무음 비프(브라우저가 사용자 인터랙션 후에만 소리 허용 — 사전 unlock)
    if (next) playBeep();
  };

  const dismissAlert = () => {
    const now = new Date().toISOString();
    lastSeenRef.current = now;
    localStorage.setItem(LASTSEEN_KEY, now);
    setAlertItems([]);
  };

  const visibleWarehouses = selectedWh === 'all' ? [...WAREHOUSES] : [selectedWh];

  return (
    <div className="space-y-4">
      {/* 날짜 헤더 */}
      <div className="bg-white border rounded-lg p-4 flex items-center gap-3 flex-wrap">
        <button onClick={() => setDate(shiftDate(date, -1))} className="w-10 h-10 flex items-center justify-center rounded-full hover:bg-gray-100">◀</button>
        <span className="font-bold text-base text-gray-800 min-w-[180px] text-center">{dateLabel(date)}</span>
        <button onClick={() => setDate(shiftDate(date, 1))} className="w-10 h-10 flex items-center justify-center rounded-full hover:bg-gray-100">▶</button>
        <input type="date" value={date} onChange={(e) => e.target.value && setDate(e.target.value)} className="border rounded px-2 py-1.5 text-sm" />
        {!isToday && <button onClick={() => setDate(todayKey())} className="px-3 py-1.5 text-xs rounded border border-blue-300 text-blue-700 bg-blue-50 hover:bg-blue-100 font-medium">오늘로</button>}
        <div className="ml-auto flex items-center gap-2">
          <span className="text-xs text-gray-500">입고 <b className="text-emerald-600">{totals.inC}</b> · 출고 <b className="text-rose-600">{totals.outC}</b></span>
          <button onClick={() => setShowAdd(true)} className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-md font-medium text-sm shadow-sm">+ 입출고 등록</button>
        </div>
      </div>

      {/* 창고 필터 */}
      <div className="bg-white border rounded-lg px-4 py-2.5 flex items-center gap-1.5 flex-wrap">
        <span className="text-xs text-gray-500 mr-1">창고:</span>
        <button
          onClick={() => setSelectedWh('all')}
          className={`px-3 py-1.5 text-sm rounded-md font-medium ${selectedWh === 'all' ? 'bg-slate-800 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}
        >전체</button>
        {WAREHOUSES.map((w) => {
          const b = byWarehouse.get(w)!;
          const cnt = b.in.length + b.out.length;
          return (
            <button
              key={w}
              onClick={() => setSelectedWh(w)}
              className={`px-3 py-1.5 text-sm rounded-md font-medium relative ${selectedWh === w ? 'bg-slate-800 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}
            >
              {w}번
              {cnt > 0 && <span className={`ml-1.5 text-[10px] px-1.5 py-0.5 rounded-full ${selectedWh === w ? 'bg-white/20' : 'bg-blue-100 text-blue-700'}`}>{cnt}</span>}
            </button>
          );
        })}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* 창고별 입출고 */}
        <div className="lg:col-span-2 space-y-4">
          {visibleWarehouses.map((w) => {
            const b = byWarehouse.get(w)!;
            return (
              <div key={w} className="bg-white border rounded-lg overflow-hidden">
                <div className="px-4 py-3 border-b bg-slate-50 flex items-center gap-2">
                  <span className="w-7 h-7 rounded-full bg-slate-700 text-white flex items-center justify-center text-sm font-bold">{w}</span>
                  <span className="font-semibold text-gray-800">{w}번 창고</span>
                  <span className="ml-auto text-xs text-gray-500">
                    입고 <b className="text-emerald-600">{b.in.length}</b> · 출고 <b className="text-rose-600">{b.out.length}</b>
                  </span>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 divide-y md:divide-y-0 md:divide-x divide-gray-100">
                  <MoveList title="입고" tone="emerald" items={b.in} onToggle={toggleDone} onRemove={removeMv} />
                  <MoveList title="출고" tone="rose" items={b.out} onToggle={toggleDone} onRemove={removeMv} />
                </div>
              </div>
            );
          })}
        </div>

        {/* 요청사항 — 모바일에서는 맨 위로 */}
        <div className="bg-white border rounded-lg overflow-hidden h-fit order-first lg:order-none">
          <div className="px-4 py-3 border-b bg-amber-50 flex items-center gap-2 flex-wrap">
            <span className="font-semibold text-amber-800 flex items-center gap-1.5">
              📝 요청사항
              {requests.filter((r) => !r.done).length > 0 && (
                <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-200 text-amber-800">{requests.filter((r) => !r.done).length}</span>
              )}
            </span>
            <label
              className={`ml-auto inline-flex items-center gap-1.5 px-2 py-1 rounded-md cursor-pointer select-none text-[11px] font-medium transition border ${
                notifyEnabled
                  ? 'bg-rose-50 border-rose-300 text-rose-700'
                  : 'bg-white border-gray-200 text-gray-500 hover:bg-gray-50'
              }`}
              title="자재관리자: 새 요청사항이 등록되면 이 화면에 알림이 뜹니다"
            >
              <input type="checkbox" checked={notifyEnabled} onChange={toggleNotify} className="w-3.5 h-3.5" />
              {notifyEnabled ? '🔔 자재관리자 ON' : '🔔 자재관리자'}
            </label>
          </div>
          <div className="p-3 space-y-2">
            <div className="flex gap-2">
              <input
                value={newRequest}
                onChange={(e) => setNewRequest(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && addRequest()}
                placeholder="자재관리자에게 전달할 내용..."
                className="flex-1 border rounded-md px-3 py-2 text-sm"
              />
              <button onClick={addRequest} disabled={!newRequest.trim()} className="px-3 py-2 bg-amber-600 text-white rounded-md text-sm font-medium hover:bg-amber-700 disabled:bg-gray-300">추가</button>
            </div>
            {requests.length === 0 ? (
              <div className="text-center text-xs text-gray-400 py-6">요청사항 없음</div>
            ) : (
              <div className="space-y-1.5">
                {requests.map((r) => (
                  <div key={r.id} className={`flex items-start gap-2 px-3 py-2 rounded-md border ${r.done ? 'bg-gray-50 border-gray-200' : 'bg-amber-50/60 border-amber-200'}`}>
                    <button onClick={() => toggleReq(r)} className="mt-0.5">
                      <span className={`w-4 h-4 inline-flex items-center justify-center rounded border text-[10px] ${r.done ? 'bg-emerald-500 border-emerald-500 text-white' : 'border-gray-300'}`}>{r.done ? '✓' : ''}</span>
                    </button>
                    <span className={`flex-1 text-sm ${r.done ? 'line-through text-gray-400' : 'text-gray-800'}`}>{r.text}</span>
                    <button onClick={() => removeReq(r)} className="text-gray-300 hover:text-red-500 text-xs">×</button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* 입출고 등록 모달 */}
      {showAdd && (
        <AddMovementModal
          date={date}
          materials={materials}
          onClose={() => setShowAdd(false)}
        />
      )}

      {/* 자재관리자 알림 오버레이 */}
      {alertItems.length > 0 && (
        <div
          onClick={dismissAlert}
          className="fixed inset-0 bg-rose-900/70 backdrop-blur-sm flex items-center justify-center z-[100] p-6 cursor-pointer animate-[pulse_1.5s_ease-in-out_infinite]"
        >
          <div className="bg-white rounded-2xl shadow-2xl max-w-2xl w-full overflow-hidden">
            <div className="px-8 py-5 bg-gradient-to-r from-rose-500 to-orange-500 text-white">
              <div className="flex items-center gap-3">
                <span className="text-5xl animate-bounce">🔔</span>
                <div>
                  <div className="text-2xl font-bold">새 요청사항 {alertItems.length}건</div>
                  <div className="text-rose-100 text-sm mt-0.5">자재관리자 확인 필요</div>
                </div>
              </div>
            </div>
            <div className="p-6 space-y-2 max-h-[50vh] overflow-y-auto">
              {alertItems.map((r) => (
                <div key={r.id} className="px-4 py-3 bg-amber-50 border-l-4 border-amber-400 rounded text-gray-800 text-base">
                  {r.text}
                </div>
              ))}
            </div>
            <div className="px-6 py-4 bg-slate-50 text-center text-sm text-gray-500 border-t">
              화면 어디든 클릭하면 닫힙니다
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function MoveList({
  title, tone, items, onToggle, onRemove,
}: {
  title: string;
  tone: 'emerald' | 'rose';
  items: Mv[];
  onToggle: (mv: Mv) => void;
  onRemove: (mv: Mv) => void;
}) {
  const tones = tone === 'emerald'
    ? { head: 'text-emerald-700 bg-emerald-50', dot: 'bg-emerald-500' }
    : { head: 'text-rose-700 bg-rose-50', dot: 'bg-rose-500' };
  return (
    <div>
      <div className={`px-3 py-1.5 text-xs font-bold flex items-center gap-1.5 ${tones.head}`}>
        <span className={`w-1.5 h-1.5 rounded-full ${tones.dot}`} /> {title} ({items.length})
      </div>
      {items.length === 0 ? (
        <div className="px-3 py-4 text-center text-xs text-gray-300">없음</div>
      ) : (
        <div className="divide-y divide-gray-100">
          {items.map((mv) => {
            const dateField = mv.type === '입고' ? mv.incomingDate : mv.expiryDate;
            const dateLabelText = mv.type === '입고' ? '입고일자' : '소비기한';
            const dateChipColor = mv.type === '입고' ? 'bg-emerald-50 border-emerald-200 text-emerald-700' : 'bg-rose-50 border-rose-200 text-rose-700';
            return (
              <div key={mv.id} className={`px-3 py-2 flex items-start gap-2 ${mv.done ? 'opacity-50' : ''}`}>
                <button onClick={() => onToggle(mv)} className="mt-0.5 flex-shrink-0">
                  <span className={`w-4 h-4 inline-flex items-center justify-center rounded border text-[10px] ${mv.done ? 'bg-emerald-500 border-emerald-500 text-white' : 'border-gray-300'}`}>{mv.done ? '✓' : ''}</span>
                </button>
                <div className="flex-1 min-w-0">
                  <div className={`text-sm font-medium ${mv.done ? 'line-through text-gray-400' : 'text-gray-800'}`}>
                    {mv.materialName}
                    {mv.spec && <span className="ml-1.5 text-xs px-1.5 py-0.5 bg-gray-100 rounded text-gray-600">{mv.spec}</span>}
                    <span className="ml-2 font-bold">{mv.qty.toLocaleString()}{mv.unit || ''}</span>
                  </div>
                </div>
                {dateField && (
                  <div className={`text-center border rounded-md px-2 py-1 flex-shrink-0 ${dateChipColor}`}>
                    <div className="text-[9px] font-bold opacity-80 leading-tight">{dateLabelText}</div>
                    <div className="text-[11px] font-mono font-bold leading-tight mt-0.5">{formatShortDate(dateField)}</div>
                  </div>
                )}
                <button onClick={() => onRemove(mv)} className="text-gray-300 hover:text-red-500 text-xs flex-shrink-0">×</button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function formatShortDate(d: string): string {
  // 2026-11-12 → "26.11.12" (연도 항상 표시)
  const [y, m, day] = d.split('-').map(Number);
  return `${String(y).slice(2)}.${m}.${day}`;
}

function AddMovementModal({
  date, materials, onClose,
}: { date: string; materials: Material[]; onClose: () => void }) {
  const [type, setType] = useState<'입고' | '출고'>('출고');
  const [warehouse, setWarehouse] = useState<number>(1);
  const [matSearch, setMatSearch] = useState('');
  const [selectedMat, setSelectedMat] = useState<Material | null>(null);
  const [spec, setSpec] = useState('');
  const [qty, setQty] = useState('');
  const [incomingDate, setIncomingDate] = useState(date);   // 입고일자 기본=현재 보고있는 날짜
  const [expiryDate, setExpiryDate] = useState('');         // 소비기한 (출고)
  const [saving, setSaving] = useState(false);

  // 모드/날짜 변경 시 입고일자 초기화
  useEffect(() => { setIncomingDate(date); }, [date]);

  const matResults = useMemo(() => {
    const q = matSearch.trim().toLowerCase();
    if (!q) return materials.slice(0, 12);
    return materials.filter((m) =>
      m.name.toLowerCase().includes(q) || (m.category || '').toLowerCase().includes(q)
    ).slice(0, 20);
  }, [materials, matSearch]);

  const save = async () => {
    const name = selectedMat?.name || matSearch.trim();
    if (!name) { alert('원재료를 선택하거나 입력하세요'); return; }
    const q = Number(qty);
    if (isNaN(q) || q <= 0) { alert('중량을 입력하세요'); return; }
    setSaving(true);
    try {
      const payload: Record<string, unknown> = {
        type, warehouse, materialName: name,
        qty: q,
        unit: 'g',
        done: false, date,
        createdAt: new Date().toISOString(),
      };
      if (spec.trim()) payload.spec = spec.trim();
      if (type === '입고' && incomingDate) payload.incomingDate = incomingDate;
      if (type === '출고' && expiryDate) payload.expiryDate = expiryDate;
      await addDoc(collection(db, 'inventory', date, 'movements'), payload);
      // 폼 리셋 (날짜는 유지 — 연속 등록 편의)
      setSelectedMat(null); setMatSearch(''); setSpec(''); setQty('');
    } catch (err) {
      alert(`저장 실패: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSaving(false);
    }
  };

  // 빠른 소비기한 버튼: 오늘, +1주, +1개월, +3개월, +6개월
  const expiryQuick = (label: string, days: number) => (
    <button
      onClick={() => {
        const [yy, mm, dd] = date.split('-').map(Number);
        const d = new Date(yy, mm - 1, dd + days);
        setExpiryDate(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
      }}
      type="button"
      className="px-2.5 py-1 rounded-md border bg-white text-xs font-medium text-gray-700 hover:bg-amber-50 hover:border-amber-300"
    >{label}</button>
  );

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-lg h-[92vh] overflow-hidden flex flex-col">
        <div className="px-5 py-4 border-b bg-gradient-to-r from-blue-50 to-indigo-50 flex items-center justify-between">
          <h3 className="font-bold text-gray-800">입출고 등록 <span className="text-xs text-gray-500 font-normal">{date}</span></h3>
          <button onClick={onClose} className="w-7 h-7 rounded-full hover:bg-gray-200 text-gray-500">×</button>
        </div>
        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          {/* 입고/출고 */}
          <div className="flex gap-2">
            {(['출고', '입고'] as const).map((t) => (
              <button
                key={t}
                onClick={() => setType(t)}
                className={`flex-1 py-2.5 rounded-md font-bold text-sm border-2 transition ${
                  type === t
                    ? (t === '출고' ? 'bg-rose-600 text-white border-rose-600' : 'bg-emerald-600 text-white border-emerald-600')
                    : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'
                }`}
              >{t}</button>
            ))}
          </div>

          {/* 창고 */}
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1.5">{type === '출고' ? '출고할 창고' : '입고할 창고'}</label>
            <div className="grid grid-cols-7 gap-1.5">
              {WAREHOUSES.map((w) => (
                <button
                  key={w}
                  onClick={() => setWarehouse(w)}
                  className={`py-2 rounded-md font-bold text-sm ${warehouse === w ? 'bg-slate-800 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}
                >{w}</button>
              ))}
            </div>
          </div>

          {/* 원재료 검색/선택 */}
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1.5">원재료</label>
            <input
              value={selectedMat ? selectedMat.name : matSearch}
              onChange={(e) => { setSelectedMat(null); setMatSearch(e.target.value); setSpec(''); }}
              placeholder="원재료명 검색 또는 직접 입력 (예: 당근)"
              className="w-full border rounded-md px-3 py-2 text-sm"
            />
            {!selectedMat && (
              <div className="mt-2 grid grid-cols-2 sm:grid-cols-3 gap-1.5 max-h-40 overflow-y-auto">
                {matResults.map((m) => (
                  <button
                    key={m.id}
                    onClick={() => { setSelectedMat(m); setMatSearch(''); setSpec((m.specs || [])[0] || ''); }}
                    className="text-left px-2.5 py-1.5 rounded border text-xs hover:bg-blue-50 hover:border-blue-200"
                  >
                    <div className="font-medium text-gray-800">{m.name}</div>
                    {m.category && <div className="text-[10px] text-gray-400">{m.category}{(m.specs || []).length ? ` · ${(m.specs || []).length}규격` : ''}</div>}
                  </button>
                ))}
                {matResults.length === 0 && <div className="col-span-full text-xs text-gray-400 py-2 text-center">검색 결과 없음 — 직접 입력하면 됩니다</div>}
              </div>
            )}
            {selectedMat && (
              <button onClick={() => { setSelectedMat(null); setSpec(''); }} className="mt-1 text-[11px] text-blue-600 hover:underline">다시 선택</button>
            )}
          </div>

          {/* 규격 */}
          {selectedMat && (selectedMat.specs || []).length > 0 && (
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1.5">규격</label>
              <div className="flex flex-wrap gap-1.5">
                <button onClick={() => setSpec('')} className={`px-2.5 py-1 rounded-full text-xs font-medium border ${spec === '' ? 'bg-slate-800 text-white border-slate-800' : 'bg-white text-gray-600 border-gray-200'}`}>규격없음</button>
                {(selectedMat.specs || []).map((s) => (
                  <button key={s} onClick={() => setSpec(s)} className={`px-2.5 py-1 rounded-full text-xs font-medium border ${spec === s ? 'bg-slate-800 text-white border-slate-800' : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'}`}>{s}</button>
                ))}
              </div>
            </div>
          )}
          {(!selectedMat || (selectedMat.specs || []).length === 0) && (
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">규격 (선택, 직접 입력)</label>
              <input value={spec} onChange={(e) => setSpec(e.target.value)} placeholder="예: 5mm" className="w-full border rounded-md px-3 py-2 text-sm" />
            </div>
          )}

          {/* 중량 */}
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">중량 <span className="text-gray-400">(g)</span></label>
            <div className="relative max-w-[180px]">
              <input type="number" inputMode="decimal" value={qty} onChange={(e) => setQty(e.target.value)} placeholder="0" className="w-full border rounded-md px-3 py-2 pr-8 text-base text-center font-bold" />
              <span className="absolute right-2.5 top-1/2 -translate-y-1/2 text-xs text-gray-400">g</span>
            </div>
          </div>

          {/* 입고일자 / 소비기한 */}
          {type === '입고' ? (
            <div>
              <label className="block text-xs font-medium text-emerald-700 mb-1.5">📅 입고일자</label>
              <input
                type="date"
                value={incomingDate}
                onChange={(e) => setIncomingDate(e.target.value)}
                className="w-full border-2 border-emerald-200 rounded-md px-3 py-2 text-base font-medium text-emerald-800 bg-emerald-50"
              />
              <p className="text-[11px] text-gray-500 mt-1">기본값은 오늘 — 다른 날짜도 선택 가능합니다.</p>
            </div>
          ) : (
            <div>
              <label className="block text-xs font-medium text-rose-700 mb-1.5">⏰ 소비기한</label>
              <div className="flex flex-wrap gap-1.5 mb-2">
                {expiryQuick('오늘', 0)}
                {expiryQuick('+1주', 7)}
                {expiryQuick('+1개월', 30)}
                {expiryQuick('+3개월', 90)}
                {expiryQuick('+6개월', 180)}
                {expiryQuick('+1년', 365)}
              </div>
              <input
                type="date"
                value={expiryDate}
                onChange={(e) => setExpiryDate(e.target.value)}
                className="w-full border-2 border-rose-200 rounded-md px-3 py-2 text-base font-medium text-rose-800 bg-rose-50"
              />
              <p className="text-[11px] text-gray-500 mt-1">위 버튼으로 빠르게 또는 직접 선택</p>
            </div>
          )}
        </div>
        <div className="px-5 py-3 border-t bg-slate-50 flex items-center gap-2">
          <button onClick={onClose} className="px-3 py-2 border rounded text-sm font-medium hover:bg-gray-100">닫기</button>
          <button
            onClick={save}
            disabled={saving || (!selectedMat && !matSearch.trim()) || !qty}
            className={`ml-auto px-5 py-2 text-white rounded font-medium disabled:bg-gray-300 disabled:cursor-not-allowed ${type === '출고' ? 'bg-rose-600 hover:bg-rose-700' : 'bg-emerald-600 hover:bg-emerald-700'}`}
          >
            {saving ? '저장중...' : `${type} 등록`}
          </button>
        </div>
      </div>
    </div>
  );
}
