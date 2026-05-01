import { Routes, Route, NavLink, useLocation } from 'react-router-dom';
import Dashboard from './pages/Dashboard';
import Machine from './pages/Machine';
import ExternalPack from './pages/ExternalPack';
import Remaining from './pages/Remaining';
import Analytics from './pages/Analytics';

export default function App() {
  return (
    <div className="min-h-screen bg-gray-100 flex flex-col">
      <Header />
      <SubNav />
      <main className="flex-1 max-w-screen-xl w-full mx-auto px-4 py-5">
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/machine/:id" element={<Machine />} />
          <Route path="/external/:id" element={<ExternalPack />} />
          <Route path="/remaining" element={<Remaining />} />
          <Route path="/analytics" element={<Analytics />} />
        </Routes>
      </main>
    </div>
  );
}

function Header() {
  const today = new Date();
  const days = ['일', '월', '화', '수', '목', '금', '토'];
  const dateLabel = `${today.getMonth() + 1}/${today.getDate()}(${days[today.getDay()]})`;

  const rightLinks = [
    { to: '/', label: '대시보드', end: true },
    { to: '/machine/1', label: '호기 입력' },
    { to: '/external/1', label: '외포장' },
    { to: '/remaining', label: '잔여량' },
    { to: '/analytics', label: '분석' },
  ];

  return (
    <header className="bg-blue-900 text-white px-5 py-2.5 flex items-center gap-4 sticky top-0 z-20">
      <div className="flex items-center gap-2.5 min-w-max">
        <div className="w-9 h-9 bg-white rounded-full flex items-center justify-center shadow">
          <span className="text-blue-900 font-black text-sm">순</span>
        </div>
        <div className="leading-tight">
          <div className="font-bold text-sm">순수본 1공장</div>
          <div className="text-blue-300 text-xs">{dateLabel}</div>
        </div>
      </div>

      <div className="flex-1" />

      <nav className="flex gap-1">
        {rightLinks.map((l) => (
          <NavLink
            key={l.to}
            to={l.to}
            end={l.end}
            className={({ isActive }) =>
              `px-3 py-1.5 text-sm rounded font-medium transition ${
                isActive
                  ? 'bg-white text-blue-900'
                  : 'text-blue-200 hover:bg-blue-800'
              }`
            }
          >
            {l.label}
          </NavLink>
        ))}
      </nav>
    </header>
  );
}

function SubNav() {
  const location = useLocation();

  const tabs = [
    { label: '입별요약', to: '/', exact: true },
    { label: '1호기', to: '/machine/1' },
    { label: '2호기', to: '/machine/2' },
    { label: '3호기', to: '/machine/3' },
    { label: '외포장-1', to: '/external/1' },
    { label: '외포장-2', to: '/external/2' },
    { label: '외포장-3', to: '/external/3' },
    { label: '잔여량', to: '/remaining' },
    { label: '분석', to: '/analytics' },
  ];

  return (
    <div className="bg-white border-b border-gray-200 sticky top-[52px] z-10">
      <div className="max-w-screen-xl mx-auto px-4">
        <nav className="flex overflow-x-auto scrollbar-none">
          {tabs.map((t) => {
            const active = t.exact
              ? location.pathname === '/' || location.pathname === ''
              : location.pathname.startsWith(t.to);
            return (
              <NavLink
                key={t.to}
                to={t.to}
                end={t.exact}
                className={`px-4 py-3 text-sm whitespace-nowrap border-b-2 transition font-medium ${
                  active
                    ? 'border-blue-900 text-blue-900'
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
