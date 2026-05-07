import { Routes, Route, NavLink, useLocation } from 'react-router-dom';
import Dashboard from './pages/Dashboard';
import Machine from './pages/Machine';
import ExternalPack from './pages/ExternalPack';
import Remaining from './pages/Remaining';
import Report from './pages/Report';
import Import from './pages/Import';
import Analytics from './pages/Analytics';
import AnalyticsMonthly from './pages/AnalyticsMonthly';
import Attendance from './pages/Attendance';
import Logo from './components/Logo';
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
  const wide = path.startsWith('/analytics/monthly') || path.startsWith('/attendance');
  return (
    <main className={`flex-1 ${wide ? 'max-w-screen-2xl' : 'max-w-screen-xl'} w-full mx-auto px-4 py-5`}>
      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/machine/:id" element={<Machine />} />
        <Route path="/external/:id" element={<ExternalPack />} />
        <Route path="/remaining" element={<Remaining />} />
        <Route path="/report" element={<Report />} />
        <Route path="/import" element={<Import />} />
        <Route path="/analytics" element={<Analytics />} />
        <Route path="/analytics/monthly" element={<AnalyticsMonthly />} />
        <Route path="/analytics/report" element={<Report />} />
        <Route path="/attendance" element={<Attendance />} />
      </Routes>
    </main>
  );
}

type Section = 'dashboard' | 'input' | 'remaining' | 'analytics' | 'attendance';

function getSection(pathname: string): Section {
  if (pathname.startsWith('/machine') || pathname.startsWith('/external')) return 'input';
  if (pathname.startsWith('/remaining')) return 'remaining';
  if (pathname.startsWith('/analytics') || pathname === '/report') return 'analytics';
  if (pathname.startsWith('/attendance')) return 'attendance';
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
  ],
  remaining: [{ label: '잔여량', to: '/remaining' }],
  analytics: [
    { label: '일별요약', to: '/analytics', exact: true },
    { label: '월별현황', to: '/analytics/monthly' },
    { label: '금속CCP', to: '/analytics/report' },
  ],
  attendance: [{ label: '조직도', to: '/attendance' }],
};

function Header() {
  const today = new Date();
  const days = ['일', '월', '화', '수', '목', '금', '토'];
  const dateLabel = `${today.getMonth() + 1}/${today.getDate()}(${days[today.getDay()]})`;
  const section = getSection(useLocation().pathname);

  const rightLinks: { section: Section; to: string; label: string; icon?: string }[] = [
    { section: 'dashboard', to: '/', label: '현황' },
    { section: 'input', to: '/machine/1', label: '입력' },
    { section: 'remaining', to: '/remaining', label: '잔여량' },
    { section: 'analytics', to: '/analytics', label: '분석' },
    { section: 'attendance', to: '/attendance', label: '조직도', icon: '📅' },
  ];

  return (
    <header className="bg-blue-700 text-white px-5 py-2.5 flex items-center gap-4 sticky top-0 z-20">
      <div className="flex items-center gap-3 min-w-max">
        <div className="bg-white rounded px-2 py-1 flex items-center shadow">
          <Logo height={32} />
        </div>
        <div className="leading-tight">
          <div className="font-bold text-sm">순수본 1공장</div>
          <div className="text-blue-100 text-xs">{dateLabel}</div>
        </div>
      </div>

      <div className="flex-1" />

      <nav className="flex gap-1 items-center">
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
