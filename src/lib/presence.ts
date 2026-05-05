import { useEffect, useState } from 'react';
import {
  collection, deleteDoc, doc, getDocs, onSnapshot, query, serverTimestamp, setDoc, where,
} from 'firebase/firestore';
import { db } from '../firebase';
import { todayKey } from './dateUtil';

function getVisitorId(): string {
  let id = localStorage.getItem('visitorId');
  if (!id) {
    id = `${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
    localStorage.setItem('visitorId', id);
  }
  return id;
}

export function useTrackVisit(): void {
  useEffect(() => {
    const date = todayKey();
    const visitorId = getVisitorId();
    setDoc(doc(db, 'visits', `${date}_${visitorId}`), {
      date,
      visitorId,
      lastSeen: serverTimestamp(),
    }).catch(() => {});

    getDocs(query(collection(db, 'visits'), where('date', '<', date)))
      .then((snap) => snap.forEach((d) => deleteDoc(d.ref).catch(() => {})))
      .catch(() => {});
  }, []);
}

export function useTodayVisitorCount(): number {
  const [count, setCount] = useState(0);
  useEffect(() => {
    const date = todayKey();
    const q = query(collection(db, 'visits'), where('date', '==', date));
    return onSnapshot(q, (snap) => setCount(snap.size));
  }, []);
  return count;
}
