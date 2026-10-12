/** 재고관리 › 구매팀 — 자재관리자 ↔ 구매팀 관리자 채팅 (카톡처럼). 등록한 기기에서만 보인다 */
import { Fragment, useEffect, useRef, useState } from 'react';
import { Navigate } from 'react-router-dom';
import ChatSetupModal from '../components/ChatSetupModal';
import { deleteChat, deviceId, getChatName, markSeen, roleLabel, sendChat, useChatMessages, useChatRole } from '../lib/purchaseChat';
import type { ChatMsg } from '../lib/purchaseChat';

const hm = (t: number) => { const d = new Date(t); return `${d.getHours() < 12 ? '오전' : '오후'} ${((d.getHours() + 11) % 12) + 1}:${String(d.getMinutes()).padStart(2, '0')}`; };
const dayLabel = (t: number) => { const d = new Date(t); return `${d.getFullYear()}년 ${d.getMonth() + 1}월 ${d.getDate()}일 ${'일월화수목금토'[d.getDay()]}요일`; };

export default function PurchaseChat() {
  const role = useChatRole();
  const [setup, setSetup] = useState(false);
  // 지운 메시지는 흔적 없이 뺀다 (양쪽 모두)
  const msgs = useChatMessages(!!role).filter((m) => !m.deleted);
  const me = deviceId();
  const name = getChatName();
  const [text, setText] = useState('');
  const [err, setErr] = useState('');
  const [delTarget, setDelTarget] = useState<ChatMsg | null>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const first = useRef(true);

  // 새 메시지가 오면 아래로 (처음엔 바로, 이후엔 부드럽게) + 읽음 처리
  useEffect(() => {
    if (!msgs.length) return;
    bottom.current?.scrollIntoView({ behavior: first.current ? 'auto' : 'smooth', block: 'end' });
    first.current = false;
    if (document.visibilityState === 'visible') markSeen(msgs[msgs.length - 1].at);
  }, [msgs.length]); // eslint-disable-line react-hooks/exhaustive-deps

  // 등록 안 한 기기는 채팅이 있는지도 모르게 재고관리로 돌려보낸다 (등록은 상단 재고관리 5초 꾹)
  if (!role) return <Navigate to="/inventory" replace />;

  const send = () => {
    const t = text.trim();
    if (!t) return;
    setText(''); setErr('');
    sendChat(t, role, name).catch((e) => setErr(`전송 실패: ${e?.message || e} — 다시 보내 주세요`));
  };

  return (
    <div className="max-w-3xl mx-auto flex flex-col h-[calc(100vh-150px)] min-h-[420px] bg-[#b2c7da] rounded-2xl overflow-hidden border">
      <div className="px-4 py-3 bg-[#a9bdce] flex items-center gap-2">
        <span className="font-bold text-gray-900">💬 구매팀 · 자재관리 대화</span>
        <span className="ml-auto text-xs text-gray-700">나: <b>{name || '이름 없음'}</b> ({roleLabel(role)})</span>
        <button onClick={() => setSetup(true)} className="px-2.5 py-1 text-xs rounded bg-white/70 hover:bg-white">내 정보</button>
      </div>
      <div ref={box} className="flex-1 overflow-y-auto px-3 py-3 space-y-1.5">
        {msgs.length === 0 && <div className="text-center text-sm text-gray-700 mt-10">아직 대화가 없습니다. 첫 메시지를 보내 보세요.</div>}
        {msgs.map((m, i) => {
          const prev = msgs[i - 1];
          const next = msgs[i + 1];
          const newDay = !prev || prev.day !== m.day;
          const mine = m.device === me;
          // 같은 사람이 1분 안에 연달아 보내면 이름은 첫 줄에만, 시각은 마지막 줄에만 (카톡처럼)
          const sameAsPrev = !newDay && prev && prev.device === m.device && Math.floor(prev.at / 60000) === Math.floor(m.at / 60000);
          const sameAsNext = next && next.day === m.day && next.device === m.device && Math.floor(next.at / 60000) === Math.floor(m.at / 60000);
          return (
            <Fragment key={m.id}>
              {newDay && (
                <div className="flex justify-center my-3">
                  <span className="px-3 py-1 rounded-full bg-black/15 text-white text-xs">{dayLabel(m.at)}</span>
                </div>
              )}
              <div className={`flex ${mine ? 'justify-end' : 'justify-start'} ${sameAsPrev ? '' : 'mt-2'}`}>
                {!mine && (
                  <div className="w-9 shrink-0 mr-1.5">
                    {!sameAsPrev && (
                      <div className={`w-9 h-9 rounded-xl flex items-center justify-center text-white text-xs font-bold ${m.role === '구매팀' ? 'bg-orange-400' : 'bg-teal-500'}`}>
                        {(m.name || roleLabel(m.role)).slice(0, 2)}
                      </div>
                    )}
                  </div>
                )}
                <div className={`flex flex-col ${mine ? 'items-end' : 'items-start'} max-w-[75%]`}>
                  {!mine && !sameAsPrev && (
                    <div className="text-xs text-gray-800 mb-0.5">{m.name || '이름 없음'} <span className="text-[10px] text-gray-600">· {roleLabel(m.role)}</span></div>
                  )}
                  <div className={`flex items-end gap-1 ${mine ? 'flex-row-reverse' : ''}`}>
                    {(
                      <div onClick={mine ? () => setDelTarget(m) : undefined}
                        title={mine ? '눌러서 삭제' : undefined}
                        className={`px-3 py-2 rounded-2xl text-[15px] leading-snug whitespace-pre-wrap break-words shadow-sm ${mine ? 'bg-[#fee500] text-gray-900 rounded-tr-md cursor-pointer active:brightness-95' : 'bg-white text-gray-900 rounded-tl-md'}`}>
                        {m.text}
                      </div>
                    )}
                    {!sameAsNext && (
                      <span className="text-[10px] text-gray-700 whitespace-nowrap mb-0.5">{m.pending ? '보내는 중' : hm(m.at)}</span>
                    )}
                  </div>
                </div>
              </div>
            </Fragment>
          );
        })}
        <div ref={bottom} />
      </div>
      {err && <div className="px-3 py-1.5 bg-rose-50 text-rose-700 text-xs">{err}</div>}
      <div className="bg-white px-2 py-2 flex items-end gap-2">
        <textarea value={text} onChange={(e) => setText(e.target.value)} rows={1}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); } }}
          placeholder="메시지 입력 (Enter 보내기 · Shift+Enter 줄바꿈)"
          className="flex-1 resize-none max-h-32 border rounded-xl px-3 py-2 text-[15px] focus:outline-none focus:ring-2 focus:ring-yellow-300" />
        <button onClick={send} disabled={!text.trim()} className="px-4 py-2 rounded-xl bg-[#fee500] font-bold text-gray-900 disabled:opacity-40">보내기</button>
      </div>
      {setup && <ChatSetupModal onClose={() => setSetup(false)} />}
      {delTarget && (
        <div className="fixed inset-0 z-[75] bg-black/50 flex items-center justify-center p-4" onClick={() => setDelTarget(null)}>
          <div className="bg-white rounded-2xl w-full max-w-sm p-5 space-y-4" onClick={(e) => e.stopPropagation()}>
            <div className="text-lg font-bold">이 메시지를 삭제할까요?</div>
            <div className="text-sm bg-gray-50 border rounded-lg px-3 py-2 whitespace-pre-wrap break-words max-h-40 overflow-y-auto">{delTarget.text}</div>
            <div className="text-xs text-gray-500">상대방 화면에서도 대화에서 사라집니다.</div>
            <div className="grid grid-cols-2 gap-2">
              <button onClick={() => setDelTarget(null)} className="py-3 rounded-lg border text-lg">취소</button>
              <button onClick={() => {
                const id = delTarget.id;
                setDelTarget(null);
                deleteChat(id).catch((e) => setErr(`삭제 실패: ${e?.message || e} — 다시 눌러 주세요`));
              }} className="py-3 rounded-lg bg-rose-600 text-white text-lg font-bold">삭제</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
