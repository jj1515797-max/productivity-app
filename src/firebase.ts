import { initializeApp } from 'firebase/app';
import { getFirestore } from 'firebase/firestore';
import { getAuth } from 'firebase/auth';

const firebaseConfig = {
  apiKey: 'AIzaSyB2NvRGbKLOHrhBcUKOoiAzwCNpBxTrmPQ',
  authDomain: 'fp-01-b64f7.firebaseapp.com',
  projectId: 'fp-01-b64f7',
  storageBucket: 'fp-01-b64f7.firebasestorage.app',
  messagingSenderId: '571043802622',
  appId: '1:571043802622:web:ceaa6fdeca768f96f924af',
};

export const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
export const auth = getAuth(app);
