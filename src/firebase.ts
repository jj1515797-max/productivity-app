import { initializeApp } from 'firebase/app';
import { getFirestore } from 'firebase/firestore';
import { getAuth } from 'firebase/auth';

const firebaseConfig = {
  apiKey: 'AIzaSyCBZqVlvzM55chVEhp5KtiSa3qCDmyTWFs',
  authDomain: 'fp-01-f04b0.firebaseapp.com',
  projectId: 'fp-01-f04b0',
  storageBucket: 'fp-01-f04b0.firebasestorage.app',
  messagingSenderId: '269690479976',
  appId: '1:269690479976:web:4c01eb272d2957d1a822dd',
};

export const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
export const auth = getAuth(app);
