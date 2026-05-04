import { initializeApp } from 'firebase/app';
import { getFirestore } from 'firebase/firestore';
import { getAuth } from 'firebase/auth';

const firebaseConfig = {
  apiKey: 'AIzaSyAPHOeTxuwvevmXUn3SyZ3xYYKGzBOtBYY',
  authDomain: 'fp-011.firebaseapp.com',
  projectId: 'fp-011',
  storageBucket: 'fp-011.firebasestorage.app',
  messagingSenderId: '903487182446',
  appId: '1:903487182446:web:49f6d828f29459166e387f',
};

export const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
export const auth = getAuth(app);
