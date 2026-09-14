/** DB 백업 SQL 을 GitHub 저장소에 올린다 — 새 세션이 가져갈 수 있게.
 *
 *  ■ 왜 이렇게 조심하는가
 *  백업 SQL 에는 생산량·단가·거래처·직원 이름까지 회사 데이터 전부가 들어 있다.
 *  공개 저장소에 올리면 그대로 전 세계에 공개된다. 그래서 올리기 전에 반드시
 *  저장소가 private 인지 확인하고, 공개면 업로드를 거부한다 (경고가 아니라 거부).
 *
 *  ■ 토큰은 코드에 넣지 않는다
 *  이 앱은 GitHub Pages(공개)로 배포되므로 번들에 넣은 값은 누구나 꺼내 볼 수 있다.
 *  토큰은 화면에서 사람이 넣고 그 기기의 localStorage 에만 둔다.
 *
 *  ■ gzip 으로 올린다
 *  SQL 은 텍스트라 10배 가까이 줄어든다. 매일 올려도 저장소가 덜 부푼다.
 */

const API = 'https://api.github.com';

export interface GhConfig {
  owner: string;
  repo: string;
  branch: string;
  /** gz 파일 경로. 고정 경로로 덮어써서 '최신본' 위치를 항상 같게 둔다 */
  path: string;
  token: string;
}

export const CFG_KEY = 'ghBackup:cfg';

export const emptyCfg = (): GhConfig => ({
  owner: '', repo: '', branch: 'main', path: 'db/latest.sql.gz', token: '',
});

export function loadCfg(): GhConfig {
  try {
    const raw = localStorage.getItem(CFG_KEY);
    if (!raw) return emptyCfg();
    return { ...emptyCfg(), ...JSON.parse(raw) };
  } catch { return emptyCfg(); }
}
export function saveCfg(c: GhConfig) {
  try { localStorage.setItem(CFG_KEY, JSON.stringify(c)); } catch { /* 용량초과 무시 */ }
}

/** 경로에서 확장자만 바꿔 매니페스트 경로를 만든다 */
export const manifestPath = (p: string) => p.replace(/\.sql\.gz$|\.sql$|\.gz$/i, '') + '.json';

async function gh(cfg: GhConfig, path: string, init?: RequestInit) {
  const r = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${cfg.token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init?.headers || {}),
    },
  });
  return r;
}

export interface RepoCheck {
  ok: boolean;
  private?: boolean;
  defaultBranch?: string;
  canPush?: boolean;
  message: string;
}

/** 올리기 전 확인 — 저장소가 있고, private 이고, 쓰기 권한이 있는가 */
export async function checkRepo(cfg: GhConfig): Promise<RepoCheck> {
  if (!cfg.owner || !cfg.repo) return { ok: false, message: '소유자와 저장소 이름을 넣으세요.' };
  if (!cfg.token) return { ok: false, message: '토큰을 넣으세요.' };
  let r: Response;
  try {
    r = await gh(cfg, `/repos/${cfg.owner}/${cfg.repo}`);
  } catch (e) {
    return { ok: false, message: `연결 실패: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (r.status === 401) return { ok: false, message: '토큰이 거부됐습니다 (만료되었거나 잘못된 토큰).' };
  if (r.status === 404) {
    return { ok: false, message: '저장소를 찾을 수 없습니다. 이름이 틀렸거나, 토큰에 그 저장소 권한이 없습니다.' };
  }
  if (!r.ok) return { ok: false, message: `저장소 조회 실패 (HTTP ${r.status}).` };
  const j = await r.json() as { private: boolean; default_branch: string; permissions?: { push?: boolean } };
  const canPush = !!j.permissions?.push;
  if (!j.private) {
    return {
      ok: false, private: false, defaultBranch: j.default_branch, canPush,
      message: '이 저장소는 공개(public)입니다. 백업 SQL 에는 생산량·단가·거래처·직원 이름이 모두 들어 있어'
        + ' 올리는 순간 전 세계에 공개됩니다. private 저장소를 따로 만들어 지정하세요.',
    };
  }
  if (!canPush) {
    return { ok: false, private: true, defaultBranch: j.default_branch, canPush,
      message: '쓰기 권한이 없는 토큰입니다. Contents 를 "Read and write" 로 주세요.' };
  }
  return { ok: true, private: true, defaultBranch: j.default_branch, canPush, message: 'private 저장소 · 쓰기 가능' };
}

/** gzip 압축. 브라우저가 CompressionStream 을 지원하지 않으면 null 을 준다 */
async function gzip(text: string): Promise<Uint8Array | null> {
  const CS = (globalThis as { CompressionStream?: unknown }).CompressionStream;
  if (typeof CS !== 'function') return null;
  const stream = new Blob([text]).stream().pipeThrough(new (CS as typeof CompressionStream)('gzip'));
  const buf = await new Response(stream).arrayBuffer();
  return new Uint8Array(buf);
}

/** 큰 바이너리를 base64 로. 한 번에 String.fromCharCode 에 넘기면 스택이 터지므로 잘라서 처리한다 */
function toBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  let s = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(s);
}
const utf8Base64 = (text: string) => {
  const bytes = new TextEncoder().encode(text);
  return toBase64(bytes);
};

/** 그 경로에 이미 파일이 있으면 sha 를 가져온다 (덮어쓰기에 필요) */
async function existingSha(cfg: GhConfig, path: string): Promise<string | null> {
  const r = await gh(cfg, `/repos/${cfg.owner}/${cfg.repo}/contents/${encodeURI(path)}?ref=${encodeURIComponent(cfg.branch)}`);
  if (r.status === 404) return null;
  if (!r.ok) return null;
  const j = await r.json() as { sha?: string };
  return j.sha || null;
}

async function put(cfg: GhConfig, path: string, base64: string, message: string) {
  const sha = await existingSha(cfg, path);
  const r = await gh(cfg, `/repos/${cfg.owner}/${cfg.repo}/contents/${encodeURI(path)}`, {
    method: 'PUT',
    body: JSON.stringify({ message, content: base64, branch: cfg.branch, ...(sha ? { sha } : {}) }),
  });
  if (!r.ok) {
    let detail = `HTTP ${r.status}`;
    try { const j = await r.json() as { message?: string }; if (j.message) detail = j.message; } catch { /* 본문 없음 */ }
    throw new Error(`${path} 업로드 실패: ${detail}`);
  }
  const j = await r.json() as { commit?: { sha?: string } };
  return j.commit?.sha || '';
}

export interface UploadMeta {
  docCount: number;
  tables: number;
  incomplete: string;
  /** 압축 전 SQL 바이트 */
  sqlBytes: number;
  /** 'YYYY-MM-DD' — 호출하는 쪽에서 넘긴다 (lib 이 시계를 갖지 않게) */
  stamp: string;
  generatedAt: string;
}

export interface UploadResult {
  commitSha: string;
  gzBytes: number;
  compressed: boolean;
  url: string;
}

/** 30MB — Contents API 는 더 큰 것도 받지만 base64 JSON 한 방으로 보내기엔 무리다 */
const MAX_UPLOAD = 30 * 1024 * 1024;

export async function uploadBackup(cfg: GhConfig, sql: string, meta: UploadMeta): Promise<UploadResult> {
  const chk = await checkRepo(cfg);
  if (!chk.ok) throw new Error(chk.message);

  const gz = await gzip(sql);
  const compressed = !!gz;
  const bytes = gz ?? new TextEncoder().encode(sql);
  if (bytes.length > MAX_UPLOAD) {
    throw new Error(
      `파일이 ${(bytes.length / 1024 / 1024).toFixed(1)}MB 라 한 번에 올릴 수 없습니다 (한도 30MB). `
      + '다운로드한 파일을 직접 저장소에 올리세요.',
    );
  }
  // 압축을 못 했으면 확장자에서 .gz 를 떼어 내용과 이름을 맞춘다
  const gzPath = compressed ? cfg.path : cfg.path.replace(/\.gz$/i, '');
  const body = compressed ? toBase64(bytes) : utf8Base64(sql);

  const head = meta.incomplete ? `DB 백업 ${meta.stamp} (불완전: ${meta.incomplete})` : `DB 백업 ${meta.stamp}`;
  const commitSha = await put(cfg, gzPath, body,
    `${head} · 문서 ${meta.docCount.toLocaleString()}건 · ${(meta.sqlBytes / 1024 / 1024).toFixed(1)}MB`);

  // 매니페스트 — 새 세션이 큰 파일을 열지 않고도 무엇이 올라와 있는지 알 수 있게
  const manifest = {
    file: gzPath,
    compressed,
    stamp: meta.stamp,
    generatedAt: meta.generatedAt,
    docCount: meta.docCount,
    tables: meta.tables,
    sqlBytes: meta.sqlBytes,
    gzBytes: bytes.length,
    incomplete: meta.incomplete || null,
    restore: compressed
      ? `git clone 후  gunzip -c ${gzPath} | psql <DB>`
      : `git clone 후  psql <DB> -f ${gzPath}`,
    note: '이 파일은 Firestore 전체를 PostgreSQL 덤프로 옮긴 것이다. 자세한 구조는 앱 저장소의 docs/DB-RESTORE.md 를 보라.',
  };
  await put(cfg, manifestPath(cfg.path), utf8Base64(JSON.stringify(manifest, null, 2)),
    `DB 백업 매니페스트 ${meta.stamp}`);

  return {
    commitSha, gzBytes: bytes.length, compressed,
    url: `https://github.com/${cfg.owner}/${cfg.repo}/blob/${cfg.branch}/${gzPath}`,
  };
}
