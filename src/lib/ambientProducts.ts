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

/** 느슨한 매칭 키: 대소문자·하이픈·언더스코어·공백 무시
 *  '순수본_한우야채진밥' / '순수본-한우야채진밥' / 'TOGO_..' vs 'togo-..' 를 같은 것으로 본다 */
export function looseKey(s: string): string {
  return (s || '').toLowerCase().replace(/[\s_\-]/g, '');
}

/** 실온이유식 ERP 품목코드 마스터 (ERP 등록명 그대로) */
export const AMBIENT_ERP: { code: string; name: string }[] = [
  { code: 'SSB55120014', name: 'togo-한우참깨애호박죽' },
  { code: 'SSB55120015', name: 'togo-닭고기버섯죽' },
  { code: 'SSB55120016', name: 'togo-한우야채진밥' },
  { code: 'SSB55120017', name: 'togo-닭고기양송이진밥' },
  { code: 'SSB55120045', name: 'togo-한우과일죽' },
  { code: 'SSB55120046', name: 'togo-닭고기애호박미역죽' },
  { code: 'SSB55120051', name: '본죽키즈 모둠야채죽' },
  { code: 'SSB55120052', name: '본죽키즈 영양닭죽' },
  { code: 'SSB55120053', name: '본죽키즈 튼튼전복죽' },
  { code: 'SSB55120054', name: '본죽키즈 한우야채죽' },
  { code: 'SSB55130014', name: '순수본-한우참깨애호박죽' },
  { code: 'SSB55130015', name: '순수본-닭고기버섯죽' },
  { code: 'SSB55130016', name: '순수본-한우야채진밥' },
  { code: 'SSB55130017', name: '순수본-닭고기양송이진밥' },
  { code: 'SSB55130018', name: '순수본-한우과일죽' },
  { code: 'SSB55130019', name: '순수본-닭고기애호박미역죽' },
  { code: 'SSB55130020', name: '순수본-한우불고기진밥' },
  { code: 'SSB55130021', name: '순수본-닭고기알밤진밥' },
  { code: 'SSB55130022', name: '순수본-한우뿌리채소죽' },
  { code: 'SSB55130023', name: '순수본-찹쌀누룽지닭죽' },
  { code: 'SSB55130024', name: '순수본-한우버섯무죽' },
  { code: 'SSB55130025', name: '순수본-오트밀버섯전복죽' },
  { code: 'SSB55130026', name: '순수본-한우사골진밥' },
  { code: 'SSB55130027', name: '순수본-전복영양진밥' },
  { code: 'SSB55130028', name: '순수본-흰살생선채소죽' },
  { code: 'SSB55130029', name: '순수본-퀴노아미역전복죽' },
  { code: 'SSB55130030', name: '순수본-게살보리진밥' },
  { code: 'SSB55130031', name: '순수본-가리비치즈진밥' },
  { code: 'SSB55130032', name: '순수본-한우치즈영양밥' },
  { code: 'SSB55130033', name: '순수본-닭살들깨버섯영양밥' },
  { code: 'SSB55130034', name: '순수본-전복버터영양밥' },
  { code: 'SSB55130035', name: '순수본-미트카레영양밥' },
];

const AMBIENT_ERP_BY_KEY = new Map(AMBIENT_ERP.map((x) => [looseKey(x.name), x]));

/** 앱 내부 실온 제품명(순수본_한우야채진밥) → ERP 품목코드/등록명 */
export function findAmbientErp(internalName: string): { code: string; name: string } | null {
  return AMBIENT_ERP_BY_KEY.get(looseKey(internalName)) || null;
}
