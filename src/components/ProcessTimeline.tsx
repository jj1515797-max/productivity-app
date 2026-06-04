import { useEffect, useState } from 'react';
import { doc, onSnapshot } from 'firebase/firestore';
import { db } from '../firebase';

type StageKey = 'pp' | 'bg' | 'ck' | 'fl' | 'pk';
type DayProductivity = {
  pot?: number; bat?: number;
  pp_people?: number; pp_start?: string; pp_end?: string;
  bg_people?: number; bg_start?: string; bg_end?: string;
  ck_people?: number; ck_start?: string; ck_end?: string;
  fl_people?: number; fl_start?: string; fl_end?: string;
  pk_people?: number; pk_start?: string; pk_end?: string;
};

type Stage = {
  key: StageKey;
  label: string;
  emoji: string;
  fill: string;
  fillLight: string;
  textOn: string;
  textOff: string;
  border: string;
};

const STAGES: Stage[] = [
  { key: 'pp', label: '전처리', emoji: '🔪', fill: '#8b5cf6', fillLight: '#ede9fe', textOn: '#ffffff', textOff: '#5b21b6', border: '#c4b5fd' },
  { key: 'bg', label: '배합',   emoji: '🥣', fill: '#2563eb', fillLight: '#dbeafe', textOn: '#ffffff', textOff: '#1e40af', border: '#93c5fd' },
  { key: 'ck', label: '취반기', emoji: '🍚', fill: '#059669', fillLight: '#d1fae5', textOn: '#ffffff', textOff: '#065f46', border: '#6ee7b7' },
  { key: 'fl', label: '화구',   emoji: '🔥', fill: '#ea580c', fillLight: '#ffedd5', textOn: '#ffffff', textOff: '#9a3412', border: '#fdba74' },
  { key: 'pk', label: '내포장', emoji: '📦', fill: '#7c3aed', fillLight: '#ede9fe', textOn: '#ffffff', textOff: '#5b21b6', border: '#c4b5fd' },
];

/** 공정별 생산성 = numerator(생산갯수) / (인원 × 시간) */
function computeProd(key: StageKey, pot: number, bat: number, people: number, mins: number): number {
  if (!people || people <= 0 || mins <= 0) return 0;
  const total = pot + bat;
  const numerator = key === 'ck' ? bat : key === 'fl' ? pot : total; // 취반기=바트, 화구=냄비, 나머지=전체
  if (numerator <= 0) return 0;
  const hrs = mins / 60;
  return Math.round(numerator / (people * hrs));
}

function parseHM(s?: string): number | null {
  if (!s) return null;
  const m = s.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = parseInt(m[1], 10), mi = parseInt(m[2], 10);
  if (isNaN(h) || isNaN(mi)) return null;
  return h * 60 + mi;
}

function formatDuration(mins: number): string {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h === 0) return `${m}분`;
  if (m === 0) return `${h}시간`;
  return `${h}시간 ${m}분`;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

export default function ProcessTimeline({ date }: { date: string }) {
  const [data, setData] = useState<DayProductivity>({});

  useEffect(() => {
    setData({});
    return onSnapshot(doc(db, 'productivity', date), (snap) => {
      setData(snap.exists() ? (snap.data() as DayProductivity) : {});
    });
  }, [date]);

  const rows = STAGES.map((s) => {
    const start = parseHM(data[`${s.key}_start` as keyof DayProductivity] as string | undefined);
    const end = parseHM(data[`${s.key}_end` as keyof DayProductivity] as string | undefined);
    const people = data[`${s.key}_people` as keyof DayProductivity] as number | undefined;
    return { stage: s, start, end, people };
  });

  // 완료된 (시작+종료 모두 있는) 공정 기준으로 시간축 범위 계산
  const completed = rows.filter((r) => r.start !== null && r.end !== null && (r.end as number) >= (r.start as number));
  const hasAny = rows.some((r) => r.start !== null || r.end !== null || r.people);
  const minMins = completed.length ? Math.min(...completed.map((r) => r.start as number)) : 8 * 60;
  const maxMins = completed.length ? Math.max(...completed.map((r) => r.end as number)) : 18 * 60;

  // 시간축 시작/끝을 시간 단위로 반올림 (1시간 여유)
  const axisStart = Math.floor(minMins / 60) * 60;
  const axisEnd = Math.ceil(maxMins / 60) * 60;
  const axisRange = Math.max(60, axisEnd - axisStart);

  // 합계: 가동시간 합
  const totalDuration = completed.reduce((s, r) => s + ((r.end as number) - (r.start as number)), 0);
  const pot = data.pot || 0;
  const bat = data.bat || 0;

  // SVG 치수
  const padL = 90, padR = 24, padT = 30, padB = 36;
  const innerW = 1100;
  const rowH = 56;
  const gap = 10;
  const innerH = STAGES.length * rowH + (STAGES.length - 1) * gap;
  const W = padL + innerW + padR;
  const H = padT + innerH + padB;

  const xFor = (mins: number) => padL + ((mins - axisStart) / axisRange) * innerW;

  // 시간 눈금 (1시간 단위)
  const ticks: number[] = [];
  for (let t = axisStart; t <= axisEnd; t += 60) ticks.push(t);

  return (
    <div className="bg-white border rounded-lg overflow-hidden">
      <div className="px-5 py-3 border-b bg-gradient-to-r from-slate-50 to-blue-50 flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-2">
          <span className="font-semibold text-gray-800">⏱ 공정별 타임라인</span>
          <span className="text-xs text-gray-500">{date}</span>
        </div>
        {hasAny && (
          <div className="flex items-center gap-3 text-xs">
            <span className="px-2 py-1 rounded-full bg-blue-100 text-blue-700 font-medium">
              총 가동 <b>{formatDuration(totalDuration)}</b>
            </span>
          </div>
        )}
      </div>

      {!hasAny ? (
        <div className="p-12 text-center text-gray-400 text-sm">
          이 날짜의 공정 데이터가 없습니다 — 조직도 → 생산성 입력에서 등록하세요
        </div>
      ) : (
        <div className="p-5">
          <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet" className="w-full h-auto block">
            {/* 시간 눈금 (세로 그리드) */}
            {ticks.map((t) => {
              const x = xFor(t);
              const h = Math.floor(t / 60);
              return (
                <g key={t}>
                  <line x1={x} y1={padT} x2={x} y2={padT + innerH} stroke="#e5e7eb" strokeWidth={1} strokeDasharray="2 3" />
                  <text x={x} y={padT - 10} textAnchor="middle" fontSize="11" fill="#6b7280">
                    {pad2(h)}:00
                  </text>
                </g>
              );
            })}

            {/* 각 공정 행 */}
            {rows.map((r, i) => {
              const y = padT + i * (rowH + gap);
              const stage = r.stage;
              const valid = r.start !== null && r.end !== null && (r.end as number) >= (r.start as number);
              const x1 = valid ? xFor(r.start as number) : null;
              const x2 = valid ? xFor(r.end as number) : null;
              const barW = valid ? (x2 as number) - (x1 as number) : 0;
              const dur = valid ? (r.end as number) - (r.start as number) : 0;

              return (
                <g key={stage.key}>
                  {/* 행 배경 */}
                  <rect x={padL} y={y} width={innerW} height={rowH} fill="#f8fafc" rx={6} />

                  {/* 라벨 (좌측) */}
                  <g transform={`translate(0, ${y})`}>
                    <rect x={0} y={0} width={padL - 8} height={rowH} fill={stage.fillLight} rx={6} />
                    <text x={padL / 2 - 4} y={rowH / 2 - 6} textAnchor="middle" fontSize="13" fill={stage.textOff} fontWeight="bold">
                      {stage.emoji} {stage.label}
                    </text>
                    {r.people !== undefined && r.people !== null && (
                      <text x={padL / 2 - 4} y={rowH / 2 + 8} textAnchor="middle" fontSize="10" fill={stage.textOff}>
                        👥 {r.people}명{valid && r.people ? `  ·  ${computeProd(stage.key, pot, bat, r.people, dur)}` : ''}
                      </text>
                    )}
                  </g>

                  {/* 데이터 */}
                  {valid ? (
                    <g>
                      {/* 막대 */}
                      <defs>
                        <linearGradient id={`grad-${stage.key}`} x1="0%" y1="0%" x2="0%" y2="100%">
                          <stop offset="0%" stopColor={stage.fill} stopOpacity="1" />
                          <stop offset="100%" stopColor={stage.fill} stopOpacity="0.8" />
                        </linearGradient>
                      </defs>
                      <rect
                        x={x1 as number}
                        y={y + 8}
                        width={barW}
                        height={rowH - 16}
                        fill={`url(#grad-${stage.key})`}
                        rx={5}
                        stroke={stage.fill}
                        strokeWidth={1}
                      />

                      {/* 시간 라벨 (막대 위) */}
                      <text x={(x1 as number) + 6} y={y + 4} fontSize="10" fill={stage.textOff} fontWeight="bold">
                        {pad2(Math.floor((r.start as number) / 60))}:{pad2((r.start as number) % 60)}
                      </text>
                      <text x={(x2 as number) - 6} y={y + 4} textAnchor="end" fontSize="10" fill={stage.textOff} fontWeight="bold">
                        {pad2(Math.floor((r.end as number) / 60))}:{pad2((r.end as number) % 60)}
                      </text>

                      {/* 막대 안 시간 표기 */}
                      {barW > 60 && (
                        <text
                          x={((x1 as number) + (x2 as number)) / 2}
                          y={y + rowH / 2 + 4}
                          textAnchor="middle"
                          fontSize="13"
                          fill={stage.textOn}
                          fontWeight="bold"
                        >
                          {formatDuration(dur)}
                        </text>
                      )}
                    </g>
                  ) : (
                    <text x={padL + 10} y={y + rowH / 2 + 4} fontSize="11" fill="#9ca3af" fontStyle="italic">
                      {r.start === null && r.end === null ? '입력 전' : (r.start === null ? '시작 시간 미입력' : '종료 시간 미입력')}
                    </text>
                  )}
                </g>
              );
            })}

            {/* 시간축 하단 베이스라인 */}
            <line x1={padL} y1={padT + innerH + 4} x2={padL + innerW} y2={padT + innerH + 4} stroke="#cbd5e1" strokeWidth={1} />
          </svg>

          {/* 하단 통계 카드 */}
          <div className="mt-4 grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-2">
            {rows.map((r) => {
              const stage = r.stage;
              const valid = r.start !== null && r.end !== null && (r.end as number) >= (r.start as number);
              const dur = valid ? (r.end as number) - (r.start as number) : 0;
              const prod = valid && r.people ? computeProd(stage.key, pot, bat, r.people, dur) : 0;
              return (
                <div
                  key={stage.key}
                  className="rounded-md border px-3 py-2 text-xs"
                  style={{ backgroundColor: stage.fillLight, borderColor: stage.border }}
                >
                  <div className="flex items-center justify-between mb-0.5">
                    <span className="font-bold" style={{ color: stage.textOff }}>
                      {stage.emoji} {stage.label}
                    </span>
                    {r.people !== undefined && r.people !== null && (
                      <span className="text-[10px]" style={{ color: stage.textOff }}>{r.people}명</span>
                    )}
                  </div>
                  {valid ? (
                    <>
                      <div className="font-mono text-[11px]" style={{ color: stage.textOff }}>
                        {pad2(Math.floor((r.start as number) / 60))}:{pad2((r.start as number) % 60)}
                        {' ~ '}
                        {pad2(Math.floor((r.end as number) / 60))}:{pad2((r.end as number) % 60)}
                      </div>
                      <div className="flex items-center justify-between mt-0.5">
                        <span className="text-[10px]" style={{ color: stage.textOff }}>{formatDuration(dur)}</span>
                        {prod > 0 && (
                          <span className="text-[11px] font-bold" style={{ color: stage.textOff }}>생산성 {prod}</span>
                        )}
                      </div>
                    </>
                  ) : (
                    <div className="text-[10px] text-gray-400 italic">데이터 없음</div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
