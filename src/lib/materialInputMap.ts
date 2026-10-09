/** 실투입(materialInput) 키를 표준소요 키에 맞추는 규칙 — 원재료수율 분석과 원재료비 수식 엑셀이 같이 쓴다. */
import { CODE_KEY_PREFIX, normalizeMaterialName } from './wasteCompute';

/** 실투입 키를 표준소요 키에 맞춰 재매핑.
 *  BOM 에 코드가 없는 원재료인데 실투입엔 코드를 넣었거나(그 반대) 하면 같은 원재료가
 *  두 키로 갈라져 '표준소요 0' + '실투입 미입력' 두 행이 되어버린다. 이름으로 2차 매칭한다.
 *
 *  ⚠ stdRows 는 반드시 '비교 대상 전 기간의 표준소요 행 합집합' 을 넘겨야 한다.
 *     한 달 것만 넘기면 그 달 생산 믹스에 따라 매칭 여부가 달라져(이름이 유일했다가 중복이 됨)
 *     두 달의 분모가 서로 다른 규칙으로 만들어지고, 증감(%p)이 수율이 아니라 매핑 변화를 재게 된다. */
export function remapInputs(
  stdRows: { key: string; name: string }[],
  inputs: Record<string, number>,
  names: Record<string, string>,
): { byStdKey: Record<string, number>; remapped: string[] } {
  // 같은 키가 여러 번 들어와도 1건으로 센다 (여러 달 행을 합쳐서 넘기므로 필수)
  const uniq = new Map<string, string>();     // 표준 키 → 이름
  stdRows.forEach((r) => { if (r.key && !uniq.has(r.key)) uniq.set(r.key, r.name); });
  const stdKeys = new Set(uniq.keys());
  // 같은 이름에 코드가 여러 개인 원재료가 실제로 있다(한우(익,민찌) → 11320010/11/12).
  // 이름이 유일할 때만 매칭한다. 중복이면 엉뚱한 코드에 붙어 조용히 틀린다.
  const nameCount = new Map<string, number>();
  uniq.forEach((nm) => {
    const n = normalizeMaterialName(nm);
    if (n) nameCount.set(n, (nameCount.get(n) || 0) + 1);
  });
  const byName = new Map<string, string>();   // 정규화 이름 → 표준 키 (유일한 것만)
  uniq.forEach((nm, key) => {
    const n = normalizeMaterialName(nm);
    if (n && nameCount.get(n) === 1 && !byName.has(n)) byName.set(n, key);
  });
  const byStdKey: Record<string, number> = {};
  const remapped: string[] = [];
  Object.entries(inputs).forEach(([k, g]) => {
    let rk = k;
    if (!stdKeys.has(k)) {
      const nm = names[k];
      const hit = (nm && byName.get(normalizeMaterialName(nm)))
        || (!k.startsWith(CODE_KEY_PREFIX) ? byName.get(k) : undefined);
      if (hit) { rk = hit; remapped.push(nm || k); }
    }
    byStdKey[rk] = (byStdKey[rk] ?? 0) + g;
  });
  return { byStdKey, remapped };
}
