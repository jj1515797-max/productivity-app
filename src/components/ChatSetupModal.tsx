/** 구매팀 채팅 — 이 기기 등록 창 (이름 + 역할). 상단 「재고관리」 5초 꾹 누르기 / 채팅 화면 「내 정보」 에서 연다 */
import { useState } from 'react';
import { CHAT_ROLES, askNotifyPermission, getChatName, getChatRole, roleLabel, setChatRole } from '../lib/purchaseChat';
import type { ChatRole } from '../lib/purchaseChat';

export default function ChatSetupModal({ onClose }: { onClose: () => void }) {
  const cur = getChatRole();
  const [name, setName] = useState(getChatName());
  const [role, setRole] = useState<ChatRole | null>(cur);
  const [confirmOff, setConfirmOff] = useState(false);
  const ok = name.trim().length > 0 && !!role;
  return (
    <div className="fixed inset-0 z-[70] bg-black/50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl w-full max-w-sm p-5 space-y-4 text-gray-900" onClick={(e) => e.stopPropagation()}>
        <div>
          <div className="text-lg font-bold">💬 구매팀 채팅 {cur ? '— 내 정보' : '— 이 기기 등록'}</div>
          <div className="text-xs text-gray-500 mt-1 leading-relaxed">
            등록한 기기에서만 대화가 보이고, 상대가 메시지를 올리면 알림이 옵니다. (PC·휴대폰 각각 따로 등록)
          </div>
        </div>
        <label className="block">
          <span className="text-sm font-semibold">이름 (대화에 표시)</span>
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} maxLength={12} placeholder="예: 안현우"
            className="mt-1 w-full border-2 rounded-lg px-3 py-2 text-lg" />
        </label>
        <div>
          <div className="text-sm font-semibold mb-1">역할</div>
          <div className="grid grid-cols-2 gap-2">
            {CHAT_ROLES.map((r) => (
              <button key={r} type="button" onClick={() => setRole(r)}
                className={`py-3 rounded-lg border-2 font-bold ${role === r ? 'border-blue-600 bg-blue-600 text-white' : 'border-gray-300 text-gray-700'}`}>{roleLabel(r)}</button>
            ))}
          </div>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <button onClick={onClose} className="py-3 rounded-lg border text-lg">취소</button>
          <button disabled={!ok} onClick={async () => { await askNotifyPermission(); setChatRole(role, name); onClose(); }}
            className="py-3 rounded-lg bg-blue-600 text-white text-lg font-bold disabled:bg-gray-300">{cur ? '저장' : '등록'}</button>
        </div>
        {cur && (
          confirmOff ? (
            <div className="flex items-center gap-2 text-sm">
              <span className="flex-1 text-rose-700">이 기기에서 대화가 안 보이고 알림도 꺼집니다.</span>
              <button onClick={() => setConfirmOff(false)} className="px-3 py-1.5 border rounded">아니요</button>
              <button onClick={() => { setChatRole(null); onClose(); }} className="px-3 py-1.5 rounded bg-rose-600 text-white font-bold">해제</button>
            </div>
          ) : (
            <button onClick={() => setConfirmOff(true)} className="w-full text-sm text-rose-600 underline">이 기기 등록 해제</button>
          )
        )}
      </div>
    </div>
  );
}
