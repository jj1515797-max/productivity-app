/** 접속 잠금 — 본서버 이전 후 이 사이트는 주인 한 명만 쓴다.
 *
 *  · 로그인 안 한 사람: 그냥 「404 Not Found」 화면 (앱이 있다는 티를 안 낸다)
 *  · 주인: 주소 끝에 ?login 을 붙여 들어와 구글 로그인 → 이후 그 기기에서는 로그인 유지
 *  · 누가 허용되는지는 코드에 적지 않는다 (사이트 코드는 공개). Firestore 보안 규칙이 UID 로 막고,
 *    여기서는 로그인 직후 한 번 읽어 보고 거부(permission-denied)되면 바로 로그아웃시켜 404 로 돌린다.
 */
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { GoogleAuthProvider, onAuthStateChanged, signInWithPopup, signOut } from 'firebase/auth';
import type { User } from 'firebase/auth';
import { doc, getDoc } from 'firebase/firestore';
import { auth, db } from '../firebase';

const APP_TITLE = '1공장 MES';
const wantsLogin = () => new URLSearchParams(window.location.search).has('login');
const cleanUrl = () => window.location.pathname;

export function logoutGoogle() {
  signOut(auth).finally(() => window.location.replace(cleanUrl()));
}

/** 규칙이 이 계정을 허용하는지 — 문서가 없어도 읽기 권한만 확인된다. 네트워크 오류 등은 허용으로 본다 */
async function allowed(): Promise<boolean> {
  try {
    await getDoc(doc(db, 'appMeta', '_authProbe'));
    return true;
  } catch (e) {
    return (e as { code?: string })?.code !== 'permission-denied';
  }
}

function NotFound() {
  return (
    <div style={{ position: 'fixed', inset: 0, background: '#fff', color: '#000', fontFamily: 'Times New Roman, serif', padding: '8px 8px' }}>
      <h1 style={{ fontSize: 32, fontWeight: 700, margin: '21px 0' }}>404 Not Found</h1>
      <hr />
      <p style={{ marginTop: 16 }}>The requested URL was not found on this server.</p>
    </div>
  );
}

export default function AuthGate({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null | undefined>(undefined);
  const [ok, setOk] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => onAuthStateChanged(auth, (u) => { setOk(null); setUser(u); }), []);
  useEffect(() => {
    if (!user) return;
    let off = false;
    allowed().then((a) => {
      if (off) return;
      if (a) { setOk(true); return; }
      signOut(auth).finally(() => window.location.replace(cleanUrl()));   // 남의 계정 → 로그아웃하고 404
    });
    return () => { off = true; };
  }, [user]);
  useEffect(() => { document.title = user && ok ? APP_TITLE : '404 Not Found'; }, [user, ok]);

  if (user === undefined || (user && ok === null)) return null;   // 확인 중엔 아무것도 안 보인다
  if (user && ok) {
    if (wantsLogin()) window.history.replaceState(null, '', cleanUrl());
    return <>{children}</>;
  }
  if (!wantsLogin()) return <NotFound />;

  const login = async () => {
    setBusy(true); setErr('');
    try {
      await signInWithPopup(auth, new GoogleAuthProvider());
    } catch (e) {
      const code = (e as { code?: string })?.code || '';
      if (code !== 'auth/popup-closed-by-user' && code !== 'auth/cancelled-popup-request') setErr(code || String(e));
    }
    setBusy(false);
  };
  return (
    <div style={{ position: 'fixed', inset: 0, background: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ textAlign: 'center', fontFamily: 'system-ui, sans-serif' }}>
        <button onClick={login} disabled={busy}
          style={{ padding: '10px 18px', border: '1px solid #ccc', borderRadius: 6, background: '#fff', fontSize: 15, cursor: 'pointer' }}>
          {busy ? '로그인 중…' : 'Google 계정으로 로그인'}
        </button>
        {err && <div style={{ marginTop: 10, fontSize: 12, color: '#b91c1c' }}>로그인 실패: {err}</div>}
      </div>
    </div>
  );
}
