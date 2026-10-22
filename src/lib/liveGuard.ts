/** 실시간 연결 지킴이 (현장 태블릿용)
 *
 *  태블릿에서 와이파이가 잠깐 끊기거나 화면이 꺼졌다 켜지면 Firestore 실시간 연결이 조용히 끊기고,
 *  다시 붙을 때까지 기다리는 간격이 점점 길어진다(1분 넘게). 그동안 다른 사람이 넣은 수량이 화면에 안 뜬다.
 *   · 화면이 다시 보이면(20초 넘게 가려졌던 경우) · 인터넷이 돌아오면 → 바로 다시 연결
 *   · 연결이 끊겨 캐시만 보고 있으면 → 3초마다 다시 연결 시도 (서버 읽기 없음)
 *   · 30초마다 서버에 그 컬렉션 문서 '개수'만 물어(읽기 1건) 화면이 가진 개수와 두 번 연속 다르면 → 다시 연결
 *  다시 연결 = disableNetwork → enableNetwork. 보내는 중인 입력은 그대로 남아 있다가 연결되면 올라간다.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { disableNetwork, enableNetwork, getCountFromServer } from 'firebase/firestore';
import type { Query } from 'firebase/firestore';
import { db } from '../firebase';

export type LiveStatus = 'live' | 'syncing' | 'offline';

let pending: Promise<void> | null = null;
/** Firestore 연결을 끊었다 바로 다시 붙인다 (동시에 여러 번 불려도 한 번만) */
export function reconnectFirestore(): Promise<void> {
  if (!pending) {
    pending = (async () => {
      try { await disableNetwork(db); await enableNetwork(db); } finally { pending = null; }
    })();
  }
  return pending;
}

/**
 * @param key        감시 대상이 바뀌면(날짜 등) 달라지는 값
 * @param makeQuery  개수를 셀 쿼리 (화면이 구독하는 것과 같은 범위)
 * @param localCount 화면이 가진 '서버에 저장 확인된' 문서 수 (보내는 중인 것 제외)
 * @param fromCache  마지막 스냅샷이 캐시에서 온 것인지 (연결이 끊기면 true)
 */
export function useLiveGuard(key: string, makeQuery: () => Query, localCount: number, fromCache: boolean) {
  const [busy, setBusy] = useState(false);
  const [netErr, setNetErr] = useState(false);
  const localRef = useRef(localCount);
  localRef.current = localCount;
  const queryRef = useRef(makeQuery);
  queryRef.current = makeQuery;

  const reconnect = useCallback(() => {
    setBusy(true);
    reconnectFirestore().catch(() => {}).finally(() => setBusy(false));
  }, []);

  // 화면 다시 보임 · 인터넷 복구 → 바로 다시 연결
  useEffect(() => {
    let hiddenAt = 0;
    const onVis = () => {
      if (document.visibilityState === 'hidden') { hiddenAt = Date.now(); return; }
      if (hiddenAt && Date.now() - hiddenAt > 20_000) reconnect();
      hiddenAt = 0;
    };
    const onOnline = () => reconnect();
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('online', onOnline);
    return () => {
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('online', onOnline);
    };
  }, [reconnect]);

  // 연결이 끊겨 캐시만 보고 있으면 3초마다 다시 붙여 본다 (Firestore 자체 재시도는 끊김이 길수록 간격이 1분 넘게 벌어진다).
  // 서버 읽기는 없다
  useEffect(() => {
    if (!fromCache) return;
    const id = window.setInterval(() => { if (document.visibilityState === 'visible') reconnect(); }, 3_000);
    return () => window.clearInterval(id);
  }, [fromCache, reconnect]);

  // 30초마다 개수 대조 — 두 번 연속 다르면 다시 연결 (방금 누른 것이 아직 올라가는 중일 수 있어 한 번은 봐준다)
  useEffect(() => {
    let miss = 0;
    const tick = async () => {
      if (document.visibilityState !== 'visible') return;
      try {
        const snap = await getCountFromServer(queryRef.current());
        setNetErr(false);
        if (snap.data().count !== localRef.current) {
          miss += 1;
          if (miss >= 2) { miss = 0; reconnect(); }
        } else miss = 0;
      } catch {
        setNetErr(true);
      }
    };
    const id = window.setInterval(tick, 30_000);
    return () => window.clearInterval(id);
  }, [key, reconnect]);

  const status: LiveStatus = netErr ? 'offline' : busy || fromCache ? 'syncing' : 'live';
  return { status, reconnect };
}

export const LIVE_LABEL: Record<LiveStatus, { text: string; cls: string; dot: string }> = {
  live: { text: '실시간', cls: 'border-emerald-300 bg-emerald-50 text-emerald-700', dot: 'bg-emerald-500' },
  syncing: { text: '연결 중…', cls: 'border-amber-300 bg-amber-50 text-amber-800', dot: 'bg-amber-500 animate-pulse' },
  offline: { text: '연결 끊김', cls: 'border-rose-300 bg-rose-50 text-rose-700', dot: 'bg-rose-500 animate-pulse' },
};
