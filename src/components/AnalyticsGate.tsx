import { useEffect, useState } from 'react';
import { Outlet } from 'react-router-dom';
import { doc, getDoc } from 'firebase/firestore';
import { db } from '../firebase';

const STORAGE_KEY = 'analyticsAuthedAt';
const TTL_MS = 12 * 60 * 60 * 1000; // 12시간

function isAuthed(): boolean {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return false;
  const ts = Number(raw);
  if (!ts || Date.now() - ts > TTL_MS) {
    localStorage.removeItem(STORAGE_KEY);
    return false;
  }
  return true;
}

export default function AnalyticsGate() {
  const [loaded, setLoaded] = useState(false);
  const [password, setPassword] = useState<string>('');
  const [input, setInput] = useState('');
  const [authed, setAuthed] = useState(false);
  const [error, setError] = useState(false);
  const [shake, setShake] = useState(false);
  const [expired, setExpired] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const snap = await getDoc(doc(db, 'settings', 'analyticsAuth'));
        const pw = (snap.data()?.password as string) || '';
        setPassword(pw);
        if (!pw) {
          setAuthed(true);
        } else {
          const wasAuthed = !!localStorage.getItem(STORAGE_KEY);
          const ok = isAuthed();
          if (ok) setAuthed(true);
          else if (wasAuthed) setExpired(true);
        }
      } finally {
        setLoaded(true);
      }
    })();
  }, []);

  const submit = () => {
    if (input === password) {
      localStorage.setItem(STORAGE_KEY, String(Date.now()));
      setAuthed(true);
      setError(false);
      setExpired(false);
      setInput('');
    } else {
      setError(true);
      setShake(true);
      setTimeout(() => setShake(false), 500);
    }
  };

  const logout = () => {
    localStorage.removeItem(STORAGE_KEY);
    setAuthed(false);
    setExpired(false);
  };

  if (!loaded) {
    return <div className="text-center text-gray-400 text-sm py-20">로딩 중...</div>;
  }

  if (!authed) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className={`bg-white border rounded-xl shadow-lg p-8 w-full max-w-sm ${shake ? 'animate-shake' : ''}`}>
          <div className="text-center mb-5">
            <div className="text-4xl mb-2">🔒</div>
            <h2 className="text-lg font-bold text-gray-800">분석 — 관리자 전용</h2>
            <p className="text-xs text-gray-500 mt-1">비밀번호를 입력하세요</p>
            {expired && (
              <div className="mt-3 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-3 py-2">
                세션이 만료되었습니다 (12시간) — 다시 로그인 해주세요
              </div>
            )}
          </div>
          <input
            type="password"
            autoFocus
            value={input}
            onChange={(e) => { setInput(e.target.value); setError(false); }}
            onKeyDown={(e) => e.key === 'Enter' && submit()}
            placeholder="비밀번호"
            className={`w-full border rounded-md px-3 py-2.5 text-base text-center font-mono tracking-wider focus:outline-none focus:ring-2 ${
              error ? 'border-red-400 focus:ring-red-200' : 'focus:ring-blue-200'
            }`}
          />
          {error && (
            <div className="text-xs text-red-600 text-center mt-2">비밀번호가 틀렸습니다</div>
          )}
          <button
            onClick={submit}
            disabled={!input}
            className="w-full mt-4 bg-blue-700 hover:bg-blue-800 text-white py-2.5 rounded-md font-semibold disabled:bg-gray-300 disabled:cursor-not-allowed"
          >
            확인
          </button>
          <div className="text-[10px] text-gray-400 text-center mt-3">
            한번 로그인하면 12시간 동안 유지됩니다
          </div>
        </div>
        <style>{`
          @keyframes shake {
            0%, 100% { transform: translateX(0); }
            25% { transform: translateX(-8px); }
            75% { transform: translateX(8px); }
          }
          .animate-shake { animation: shake 0.4s ease-in-out; }
        `}</style>
      </div>
    );
  }

  return (
    <div className="relative">
      {password && (
        <button
          onClick={logout}
          className="absolute -top-2 right-0 text-[11px] text-gray-400 hover:text-gray-700 flex items-center gap-1 z-10"
          title="로그아웃"
        >
          🔓 로그아웃
        </button>
      )}
      <Outlet />
    </div>
  );
}
