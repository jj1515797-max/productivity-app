/** 구매팀 채팅 — 상대 메시지가 오면 「확인」을 누를 때까지 계속 울리는 알림 (등록한 기기에서만)
 *
 *  · 다른 창·다른 탭을 앞에 띄워 놓아도 울리도록, 타이머 대신 반복 재생하는 알림음(직접 만든 WAV)을 쓴다.
 *    (브라우저는 뒤에 있는 탭의 타이머를 늦추지만 재생 중인 소리는 끊지 않는다)
 *  · 창이 뒤에 있으면 윈도우 알림을 띄우고, 확인 안 하면 20초마다 다시 띄운다. 누르면 채팅으로 온다.
 *  · 단, 이 기기에서 MES 탭이 열려 있어야 한다 (최소화·다른 탭은 괜찮고, 브라우저를 끄면 안 됨). */
import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { unlockAudio } from '../lib/cooling';
import type { ChatMsg } from '../lib/purchaseChat';

/** 띵-동-띵 2.4초짜리 알림음 WAV (반복 재생용) */
let wavUrl: string | null = null;
function alarmUrl(): string {
  if (wavUrl) return wavUrl;
  const sr = 22050, dur = 2.4, n = Math.floor(sr * dur);
  const pcm = new Float32Array(n);
  const tone = (f: number, start: number, len: number) => {
    const s0 = Math.floor(start * sr), s1 = Math.min(n, Math.floor((start + len) * sr));
    for (let i = s0; i < s1; i += 1) {
      const t = (i - s0) / sr;
      const env = Math.min(1, t * 60) * Math.exp(-4 * t);
      pcm[i] += Math.sin(2 * Math.PI * f * t) * env * 0.5;
    }
  };
  tone(988, 0, 0.5); tone(1319, 0.22, 0.6); tone(1568, 0.5, 0.8);
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const w = (o: number, str: string) => { for (let i = 0; i < str.length; i += 1) v.setUint8(o + i, str.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  w(36, 'data'); v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i += 1) v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, pcm[i])) * 32767, true);
  wavUrl = URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
  return wavUrl;
}

export default function ChatAlarm({ unread }: { unread: ChatMsg[] }) {
  const nav = useNavigate();
  const on = unread.length > 0;
  const audio = useRef<HTMLAudioElement | null>(null);
  const onRef = useRef(on);
  onRef.current = on;
  if (!audio.current && typeof Audio !== 'undefined') {
    audio.current = new Audio(alarmUrl());
    audio.current.loop = true;
  }
  // 브라우저는 사용자가 한 번은 화면을 눌러야 소리를 낼 수 있다 — 처음 누를 때 소리 잠금을 풀어 둔다
  useEffect(() => {
    const u = () => {
      unlockAudio();
      const a = audio.current;
      if (a && a.paused && !onRef.current) { a.muted = true; a.play().then(() => { a.pause(); a.muted = false; a.currentTime = 0; }).catch(() => { a.muted = false; }); }
    };
    window.addEventListener('pointerdown', u, { once: false });
    window.addEventListener('keydown', u);
    return () => { window.removeEventListener('pointerdown', u); window.removeEventListener('keydown', u); };
  }, []);
  // 울림: 반복 재생 + 진동 + 탭 제목 깜빡임
  useEffect(() => {
    const a = audio.current;
    if (!on) { if (a) { a.pause(); a.currentTime = 0; } return; }
    if (a) { a.muted = false; a.volume = 1; a.play().catch(() => {}); }
    const base = document.title.replace(/^💬 새 메시지 \d+건 · /, '');
    let flip = false;
    const t = window.setInterval(() => {
      flip = !flip;
      document.title = flip ? `💬 새 메시지 ${unread.length}건 · ${base}` : base;
      try { navigator.vibrate?.([400, 150, 400]); } catch { /* noop */ }
      // 소리가 막혀 멈췄으면 다시 시도
      if (a && a.paused) a.play().catch(() => {});
    }, 1500);
    return () => { window.clearInterval(t); document.title = base; if (a) { a.pause(); a.currentTime = 0; } };
  }, [on, unread.length]);
  // 창이 뒤에 있으면 윈도우 알림을 확인할 때까지 20초마다 다시
  useEffect(() => {
    if (!on || !('Notification' in window) || Notification.permission !== 'granted') return;
    const show = () => {
      if (document.visibilityState === 'visible') return;
      try {
        const n = new Notification(`💬 새 메시지 ${unread.length}건 — 대화를 확인하세요`, {
          body: '구매팀 채팅을 열어 대화를 확인해 주세요.',
          tag: 'ssbon-purchase-chat', requireInteraction: true, renotify: true,
        } as NotificationOptions);
        n.onclick = () => { window.focus(); nav('/inventory/chat'); n.close(); };
      } catch { /* noop */ }
    };
    const t = window.setInterval(show, 20_000);
    return () => window.clearInterval(t);
  }, [on, unread, nav]);

  if (!on) return null;
  return (
    <div className="fixed inset-0 z-[80] bg-black/60 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl w-full max-w-md overflow-hidden shadow-2xl text-gray-900">
        <div className="bg-[#fee500] px-5 py-4">
          <div className="text-2xl font-extrabold">💬 새 메시지 {unread.length}건</div>
          <div className="text-sm text-gray-800 mt-0.5">구매팀 채팅 — 확인할 때까지 알림이 울립니다</div>
        </div>
        <div className="px-5 py-5 text-center text-lg text-gray-700">
          구매팀 채팅에 새 메시지가 왔습니다.<br />대화를 확인해 주세요.
        </div>
        <div className="px-5 pb-5">
          <button onClick={() => nav('/inventory/chat')} className="w-full py-4 rounded-xl bg-blue-600 text-white text-xl font-bold">확인 (대화 보기)</button>
        </div>
      </div>
    </div>
  );
}
