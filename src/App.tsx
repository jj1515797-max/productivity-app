import { Routes, Route, NavLink, useLocation } from 'react-router-dom';
import Dashboard from './pages/Dashboard';
import Machine from './pages/Machine';
import ExternalPack from './pages/ExternalPack';
import Remaining from './pages/Remaining';
import RemainAnalysis from './pages/RemainAnalysis';
import Report from './pages/Report';
import Import from './pages/Import';
import Analytics from './pages/Analytics';
import AnalyticsMonthly from './pages/AnalyticsMonthly';
import Attendance from './pages/Attendance';
import ProductivityInput from './pages/ProductivityInput';
import Productivity from './pages/Productivity';
import Under10 from './pages/Under10';
import Waste from './pages/Waste';
import MaterialAnalysis from './pages/MaterialAnalysis';
import MaterialAnalysis2 from './pages/MaterialAnalysis2';
import ProductSettings from './pages/ProductSettings';
import Inventory from './pages/Inventory';
import Remix from './pages/Remix';
import Scoop from './pages/Scoop';
import Logo from './components/Logo';
import AnalyticsGate from './components/AnalyticsGate';
import { useTrackVisit } from './lib/presence';

export default function App() {
  useTrackVisit();
  return (
    <div className="min-h-screen bg-gray-100 flex flex-col">
      <Header />
      <SubNav />
      <MainContainer />
    </div>
  );
}

function MainContainer() {
  const path = useLocation().pathname;
  const wide = path.startsWith('/analytics/monthly') || path.startsWith('/analytics/remix') || path.startsWith('/analytics/productivity') || path.startsWith('/analytics/material') || path.startsWith('/analytics/remain-analysis') || path.startsWith('/attendance') || path.startsWith('/inventory');
  return (
    <main className={`flex-1 ${wide ? 'max-w-screen-2xl' : 'max-w-screen-xl'} w-full mx-auto px-4 py-5`}>
      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/machine/:id" element={<Machine />} />
        <Route path="/external/:id" element={<ExternalPack />} />
        <Route path="/scoop" element={<Scoop />} />
        <Route path="/scoop/board" element={<Scoop board />} />
        <Route path="/remaining" element={<Remaining />} />
        <Route path="/report" element={<Report />} />
        <Route path="/import" element={<Import />} />
        <Route element={<AnalyticsGate />}>
          <Route path="/analytics" element={<Analytics />} />
          <Route path="/analytics/monthly" element={<AnalyticsMonthly />} />
          <Route path="/analytics/remaining" element={<Remaining />} />
          <Route path="/analytics/remain-analysis" element={<RemainAnalysis />} />
          <Route path="/analytics/remix" element={<Remix />} />
          <Route path="/analytics/productivity" element={<Productivity />} />
          <Route path="/analytics/under10" element={<Under10 />} />
          <Route path="/analytics/waste" element={<Waste />} />
          <Route path="/analytics/report" element={<Report />} />
          <Route path="/analytics/material" element={<MaterialAnalysis />} />
          <Route path="/analytics/material2" element={<MaterialAnalysis2 />} />
          <Route path="/analytics/settings" element={<ProductSettings />} />
        </Route>
        <Route path="/attendance" element={<Attendance />} />
        <Route path="/attendance/productivity" element={<ProductivityInput />} />
        <Route path="/inventory" element={<Inventory />} />
      </Routes>
    </main>
  );
}

type Section = 'dashboard' | 'input' | 'analytics' | 'attendance' | 'inventory';

function getSection(pathname: string): Section {
  if (pathname.startsWith('/machine') || pathname.startsWith('/external') || pathname.startsWith('/scoop')) return 'input';
  if (pathname.startsWith('/analytics') || pathname === '/report' || pathname === '/remaining') return 'analytics';
  if (pathname.startsWith('/attendance')) return 'attendance';
  if (pathname.startsWith('/inventory')) return 'inventory';
  return 'dashboard';
}

const SUB_TABS: Record<Section, { label: string; to: string; exact?: boolean }[]> = {
  dashboard: [],
  input: [
    { label: '1호기', to: '/machine/1' },
    { label: '2호기', to: '/machine/2' },
    { label: '3호기', to: '/machine/3' },
    { label: '외포장-1', to: '/external/1' },
    { label: '외포장-2', to: '/external/2' },
    { label: '외포장-3', to: '/external/3' },
    { label: '내포장', to: '/scoop' },
    { label: '내포장 현황판', to: '/scoop/board' },
  ],
  analytics: [
    { label: '일별요약', to: '/analytics', exact: true },
    { label: '월별현황', to: '/analytics/monthly' },
    { label: '잔여량', to: '/analytics/remaining' },
    { label: '잔여량분석', to: '/analytics/remain-analysis' },
    { label: '잔여량/재배합', to: '/analytics/remix' },
    { label: '생산성', to: '/analytics/productivity' },
    { label: '10ea미만', to: '/analytics/under10' },
    { label: '폐기', to: '/analytics/waste' },
    { label: '금속CCP', to: '/analytics/report' },
    { label: '원재료분석', to: '/analytics/material' },
    { label: '원재료분석2', to: '/analytics/material2' },
    { label: '설정', to: '/analytics/settings' },
  ],
  attendance: [
    { label: '조직도', to: '/attendance', exact: true },
    { label: '생산성 입력', to: '/attendance/productivity' },
  ],
  inventory: [{ label: '재고관리', to: '/inventory' }],
};

function Header() {
  const today = new Date();
  const days = ['일', '월', '화', '수', '목', '금', '토'];
  const dateLabel = `${today.getMonth() + 1}/${today.getDate()}(${days[today.getDay()]})`;
  const location = useLocation();
  const section = getSection(location.pathname);
  const onAnalytics = location.pathname.startsWith('/analytics');
  const analyticsAuthed = onAnalytics && !!localStorage.getItem('analyticsAuthedAt');

  const rightLinks: { section: Section; to: string; label: string; icon?: string }[] = [
    { section: 'dashboard', to: '/', label: '현황' },
    { section: 'input', to: '/machine/1', label: '입력' },
    { section: 'analytics', to: '/analytics', label: '분석' },
    { section: 'attendance', to: '/attendance', label: '조직도', icon: '📅' },
    { section: 'inventory', to: '/inventory', label: '재고관리', icon: '📦' },
  ];

  return (
    <header className="bg-blue-700 text-white sticky top-0 z-20">
      {/* 상단: 로고/타이틀 + (PC 한정) 우측 네비 */}
      <div className="px-3 sm:px-5 py-2 sm:py-2.5 flex items-center gap-3 sm:gap-4">
        <div className="flex items-center gap-2 sm:gap-3 min-w-max">
          <div className="bg-white rounded px-1.5 py-0.5 sm:px-2 sm:py-1 flex items-center shadow">
            <Logo height={28} />
          </div>
          <div className="leading-tight">
            <div className="font-bold text-xs sm:text-sm">순수본 1공장 MES</div>
            <div className="text-blue-100 text-[10px] sm:text-xs">{dateLabel}</div>
          </div>
        </div>

        <div className="flex-1" />

        {/* PC: 우측 네비 인라인 */}
        <nav className="hidden sm:flex gap-1 items-center">
          {rightLinks.map((l, i) => {
            const active = section === l.section;
            const showDivider = l.section === 'attendance' && i > 0;
            return (
              <span key={l.to} className="flex items-center gap-1">
                {showDivider && <span className="w-px h-5 bg-blue-400 mx-1.5" aria-hidden />}
                <NavLink
                  to={l.to}
                  className={`px-3 py-1.5 text-sm rounded font-medium transition flex items-center gap-1.5 ${
                    active ? 'bg-white text-blue-700' : 'text-blue-100 hover:bg-blue-800'
                  }`}
                >
                  {l.icon && <span className="text-xs">{l.icon}</span>}
                  {l.label}
                </NavLink>
              </span>
            );
          })}
          {analyticsAuthed && (
            <button
              onClick={() => { localStorage.removeItem('analyticsAuthedAt'); window.location.reload(); }}
              className="ml-2 px-2.5 py-1 text-xs rounded bg-blue-800 hover:bg-blue-900 text-blue-100 hover:text-white font-medium flex items-center gap-1"
              title="분석 로그아웃"
            >
              🔓 로그아웃
            </button>
          )}
        </nav>
      </div>

      {/* 모바일: 네비를 두번째 줄로 분리, 화면폭 꽉채워 5등분 */}
      <nav className="sm:hidden grid grid-cols-5 gap-0.5 px-1.5 pb-1.5 bg-blue-700">
        {rightLinks.map((l) => {
          const active = section === l.section;
          return (
            <NavLink
              key={l.to}
              to={l.to}
              className={`px-1 py-1.5 text-xs rounded font-medium transition flex flex-col items-center justify-center gap-0.5 ${
                active ? 'bg-white text-blue-700' : 'text-blue-100 active:bg-blue-800'
              }`}
            >
              {l.icon && <span className="text-sm leading-none">{l.icon}</span>}
              <span className="leading-none">{l.label}</span>
            </NavLink>
          );
        })}
        {analyticsAuthed && (
          <button
            onClick={() => { localStorage.removeItem('analyticsAuthedAt'); window.location.reload(); }}
            className="col-span-5 mt-1 py-1 text-[11px] rounded bg-blue-800 text-blue-100 font-medium"
          >
            🔓 분석 로그아웃
          </button>
        )}
      </nav>
    </header>
  );
}

function SubNav() {
  const location = useLocation();
  const tabs = SUB_TABS[getSection(location.pathname)];
  if (tabs.length === 0) return null;

  return (
    <div className="bg-white border-b border-gray-200 sticky top-[52px] z-10">
      <div className="max-w-screen-xl mx-auto px-4">
        <nav className="flex overflow-x-auto scrollbar-none">
          {tabs.map((t) => {
            const active = t.exact
              ? location.pathname === t.to
              : location.pathname.startsWith(t.to);
            return (
              <NavLink
                key={t.to}
                to={t.to}
                end={t.exact}
                className={`px-4 py-3 text-sm whitespace-nowrap border-b-2 transition font-medium ${
                  active
                    ? 'border-blue-600 text-blue-700'
                    : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                }`}
              >
                {t.label}
              </NavLink>
            );
          })}
        </nav>
      </div>
    </div>
  );
}
