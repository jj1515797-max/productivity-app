/** 재고관리 › 구매팀 채팅 — 자재관리자 ↔ 구매팀 관리자
 *
 *  · 상단 「재고관리」 버튼을 5초 꾹 누르면 이 기기를 자재관리자 / 구매팀으로 등록한다 (localStorage — 기기별).
 *  · 등록한 기기에서만 대화가 보이고, 상대가 올린 새 메시지가 오면 알림·소리·진동 + 버튼에 안 읽은 개수.
 *  · 등록할 때 이름(닉네임)을 적고, 대화에는 그 이름 + 역할이 붙는다 (카톡처럼 내 말은 오른쪽, 상대는 왼쪽)
 *  · Firestore `purchaseChat/{auto}` = { text, name, role, device, at, day }
 *    (앱 전체가 로그인 없이 쓰는 구조라 화면에서 가리는 것이다 — 데이터 자체를 암호화하지는 않는다)
 */
import { useEffect, useState } from 'react';
import { addDoc, collection, limit, onSnapshot, orderBy, query } from 'firebase/firestore';
import { db } from '../firebase';
import { fireNotification, supportsNotification } from './completionAlert';

export const CHAT_COL = 'purchaseChat';
export type ChatRole = '자재관리' | '구매팀';
export const CHAT_ROLES: ChatRole[] = ['자재관리', '구매팀'];
export const roleLabel = (r: ChatRole) => (r === '자재관리' ? '자재관리자' : '구매팀');

export interface ChatMsg {
  id: string;
  text: string;
  name: string;
  role: ChatRole;
  device: string;
  at: number;
  day: string;
  pending?: boolean;
}

const KEY_ROLE = 'purchaseChat:role';
const KEY_NAME = 'purchaseChat:name';
const KEY_DEVICE = 'purchaseChat:device';
const KEY_SEEN = 'purchaseChat:lastSeen';
const EVT = 'ssbon:chat-changed';

export function getChatRole(): ChatRole | null {
  try { const v = localStorage.getItem(KEY_ROLE); return v === '자재관리' || v === '구매팀' ? v : null; } catch { return null; }
}
export function getChatName(): string {
  try { return localStorage.getItem(KEY_NAME) || ''; } catch { return ''; }
}
/** 등록 / 정보 변경. r=null 이면 이 기기 등록 해제 (이름은 남겨 다음 등록 때 채워 둔다) */
export function setChatRole(r: ChatRole | null, name?: string) {
  try {
    if (name !== undefined) localStorage.setItem(KEY_NAME, name.trim());
    if (r) {
      localStorage.setItem(KEY_ROLE, r);
      // 등록 시점 이전 메시지로 알림이 쏟아지지 않게
      if (!localStorage.getItem(KEY_SEEN)) localStorage.setItem(KEY_SEEN, String(Date.now()));
    } else localStorage.removeItem(KEY_ROLE);
  } catch { /* noop */ }
  window.dispatchEvent(new Event(EVT));
}
export function deviceId(): string {
  try {
    let d = localStorage.getItem(KEY_DEVICE);
    if (!d) { d = Math.random().toString(36).slice(2, 10) + Date.now().toString(36); localStorage.setItem(KEY_DEVICE, d); }
    return d;
  } catch { return 'unknown'; }
}
export function getLastSeen(): number {
  try { return Number(localStorage.getItem(KEY_SEEN)) || 0; } catch { return 0; }
}
export function markSeen(at = Date.now()) {
  try { if (at > getLastSeen()) localStorage.setItem(KEY_SEEN, String(at)); } catch { /* noop */ }
  window.dispatchEvent(new Event(EVT));
}

export async function askNotifyPermission() {
  if (supportsNotification() && Notification.permission === 'default') {
    try { await Notification.requestPermission(); } catch { /* noop */ }
  }
}

const dayOf = (t: number) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export function sendChat(text: string, role: ChatRole, name: string) {
  const at = Date.now();
  return addDoc(collection(db, CHAT_COL), { text, name, role, device: deviceId(), at, day: dayOf(at) });
}

/** 등록된 기기인지 (다른 화면에서 등록·해제하면 바로 반영) */
export function useChatRole(): ChatRole | null {
  const [role, setRole] = useState(getChatRole());
  useEffect(() => {
    const sync = () => setRole(getChatRole());
    window.addEventListener(EVT, sync);
    window.addEventListener('storage', sync);
    return () => { window.removeEventListener(EVT, sync); window.removeEventListener('storage', sync); };
  }, []);
  return role;
}

/** 최근 메시지 구독 (등록된 기기에서만) */
export function useChatMessages(on: boolean, max = 300): ChatMsg[] {
  const [list, setList] = useState<ChatMsg[]>([]);
  useEffect(() => {
    if (!on) { setList([]); return; }
    return onSnapshot(query(collection(db, CHAT_COL), orderBy('at', 'desc'), limit(max)), { includeMetadataChanges: true }, (s) => {
      const a: ChatMsg[] = [];
      s.forEach((d) => a.push({ ...(d.data() as Omit<ChatMsg, 'id'>), id: d.id, pending: d.metadata.hasPendingWrites }));
      a.reverse();
      setList(a);
    }, () => {});
  }, [on, max]);
  return list;
}

/** 앱 전체에서 한 번 — 등록된 기기면 새 메시지 알림 + 안 읽은 메시지. 채팅 화면을 보고 있으면 알림 대신 읽음 처리 */
export function useChatWatcher(onChatPage: boolean): ChatMsg[] {
  const role = useChatRole();
  const msgs = useChatMessages(!!role, 100);
  const [seen, setSeen] = useState(getLastSeen());
  useEffect(() => {
    const sync = () => setSeen(getLastSeen());
    window.addEventListener(EVT, sync);
    return () => window.removeEventListener(EVT, sync);
  }, []);
  const me = deviceId();
  const unreadMsgs = msgs.filter((m) => m.device !== me && m.at > seen);
  // 채팅 화면을 띄워 둔 채 다른 창에 있다가 돌아오면 읽음
  useEffect(() => {
    if (!role || !onChatPage) return;
    const onVis = () => { if (document.visibilityState === 'visible' && msgs.length) markSeen(msgs[msgs.length - 1].at); };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, [role, onChatPage, msgs]);
  // 새로 들어온 것만 한 번씩 알림
  const [notified, setNotified] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (!role) return;
    if (onChatPage && document.visibilityState === 'visible') {
      if (msgs.length) markSeen(msgs[msgs.length - 1].at);
      return;
    }
    const fresh = unreadMsgs.filter((m) => !notified.has(m.id) && !m.pending);
    if (fresh.length === 0) return;
    const last = fresh[fresh.length - 1];
    fireNotification(`💬 ${last.name || roleLabel(last.role)} (${roleLabel(last.role)})${fresh.length > 1 ? ` · 새 메시지 ${fresh.length}건` : ''}`, last.text.slice(0, 120), 'ssbon-purchase-chat');
    setNotified((p) => { const n = new Set(p); fresh.forEach((m) => n.add(m.id)); return n; });
  }, [msgs, role, onChatPage]); // eslint-disable-line react-hooks/exhaustive-deps
  return role ? unreadMsgs.filter((m) => !m.pending) : [];
}
