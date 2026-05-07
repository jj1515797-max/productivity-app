export type AmbientCategory = 'TOGO' | '본죽키즈' | '순수본' | '영양밥';

export const AMBIENT_CATEGORIES: AmbientCategory[] = ['TOGO', '본죽키즈', '순수본', '영양밥'];

const RAW_PRODUCTS = [
  'TOGO_한우참깨애호박죽',
  'TOGO_한우야채진밥',
  '본죽키즈_모둠야채죽',
  '본죽키즈_영양닭죽',
  '본죽키즈_튼튼전복죽',
  '본죽키즈_한우야채죽',
  '순수본_한우참깨애호박죽',
  '순수본_닭고기버섯죽',
  '순수본_한우야채진밥',
  '순수본_닭고기양송이진밥',
  '순수본_한우과일죽',
  '순수본_닭고기애호박미역죽',
  '순수본_한우불고기진밥',
  '순수본_닭고기알밤진밥',
  '순수본_한우뿌리채소죽',
  '순수본_찹쌀누룽지닭죽',
  '순수본_한우버섯무죽',
  '순수본_오트밀버섯전복죽',
  '순수본_한우사골진밥',
  '순수본_전복영양진밥',
  '순수본_흰살생선채소죽',
  '순수본_퀴노아미역전복죽',
  '순수본_게살보리진밥',
  '순수본_가리비치즈진밥',
  '순수본_한우치즈영양밥',
  '순수본_닭살들깨버섯영양밥',
  '순수본_전복버터영양밥',
  '순수본_미트카레영양밥',
];

export function categorize(name: string): AmbientCategory {
  if (name.startsWith('TOGO_')) return 'TOGO';
  if (name.startsWith('본죽키즈_')) return '본죽키즈';
  if (name.endsWith('영양밥')) return '영양밥';
  return '순수본';
}

export const AMBIENT_PRODUCTS: { name: string; category: AmbientCategory }[] = RAW_PRODUCTS.map(
  (name) => ({ name, category: categorize(name) })
);

export const CATEGORY_STYLES: Record<AmbientCategory, { chip: string; soft: string; text: string; border: string }> = {
  TOGO:    { chip: 'bg-blue-500',    soft: 'bg-blue-50',    text: 'text-blue-700',    border: 'border-blue-200' },
  본죽키즈: { chip: 'bg-amber-500',   soft: 'bg-amber-50',   text: 'text-amber-700',   border: 'border-amber-200' },
  순수본:   { chip: 'bg-emerald-500', soft: 'bg-emerald-50', text: 'text-emerald-700', border: 'border-emerald-200' },
  영양밥:   { chip: 'bg-sky-500',     soft: 'bg-sky-50',     text: 'text-sky-700',     border: 'border-sky-200' },
};

// Firestore doc ID 안전화 (현재는 Korean/언더스코어 모두 허용되므로 그대로 사용)
export function productSlug(name: string): string {
  return name;
}
