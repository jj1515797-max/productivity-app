import { useEffect, useState } from 'react';
import { collection, deleteDoc, doc, onSnapshot, serverTimestamp, setDoc, Timestamp } from 'firebase/firestore';
import { db } from '../firebase';

const HEARTBEAT_MS = 15000;
const STALE_MS = 35000;

export function usePresence(): number {
  const [count, setCount] = useState(0);

  useEffect(() => {
    const sessionId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const ref = doc(db, 'presence', sessionId);

    const beat = () => setDoc(ref, { lastSeen: serverTimestamp() }).catch(() => {});
    beat();
    const interval = setInterval(beat, HEARTBEAT_MS);

    const onUnload = () => deleteDoc(ref).catch(() => {});
    window.addEventListener('beforeunload', onUnload);

    const unsub = onSnapshot(collection(db, 'presence'), (snap) => {
      const now = Date.now();
      let active = 0;
      snap.forEach((d) => {
        const ts = d.data().lastSeen as Timestamp | undefined;
        if (!ts) {
          deleteDoc(d.ref).catch(() => {});
          return;
        }
        const age = now - ts.toMillis();
        if (age < STALE_MS) {
          active++;
        } else if (age > 5 * 60 * 1000 && d.id !== sessionId) {
          deleteDoc(d.ref).catch(() => {});
        }
      });
      setCount(active);
    });

    return () => {
      clearInterval(interval);
      window.removeEventListener('beforeunload', onUnload);
      unsub();
      deleteDoc(ref).catch(() => {});
    };
  }, []);

  return count;
}
