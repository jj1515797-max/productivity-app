import { todayKey } from './dateUtil';

const KEY = 'viewDate';

type Saved = { date: string; chosenOn: string };

export function loadViewDate(): string {
  const today = todayKey();
  const raw = localStorage.getItem(KEY);
  if (!raw) return today;
  try {
    const parsed = JSON.parse(raw) as Saved;
    if (parsed.chosenOn === today) return parsed.date;
  } catch {
    // older format: plain string
    if (raw === today) return raw;
  }
  return today;
}

export function saveViewDate(date: string) {
  const payload: Saved = { date, chosenOn: todayKey() };
  localStorage.setItem(KEY, JSON.stringify(payload));
}
