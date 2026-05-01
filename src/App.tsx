import { Routes, Route, NavLink } from 'react-router-dom';
import Dashboard from './pages/Dashboard';
import Machine from './pages/Machine';
import ExternalPack from './pages/ExternalPack';
import Remaining from './pages/Remaining';
import Analytics from './pages/Analytics';

export default function App() {
  return (
    <div className="min-h-screen flex flex-col">
      <Header />
      <main className="flex-1 max-w-screen-2xl w-full mx-auto p-4">
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
  const linkClass = ({ isActive }: { isActive: boolean }) =>
    `px-3 py-2 text-sm rounded-md transition ${
      isActive ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-200'
    }`;

  return (
    <header className="bg-white border-b border-slate-200 sticky top-0 z-10">
      <div className="max-w-screen-2xl mx-auto px-4 py-2 flex items-center gap-2 overflow-x-auto">
        <h1 className="text-base font-bold mr-3 whitespace-nowrap">안돈 생산관리</h1>
        <nav className="flex gap-1 flex-wrap">
          <NavLink to="/" end className={linkClass}>대시보드</NavLink>
          <NavLink to="/machine/1" className={linkClass}>1호기</NavLink>
          <NavLink to="/machine/2" className={linkClass}>2호기</NavLink>
          <NavLink to="/machine/3" className={linkClass}>3호기</NavLink>
          <NavLink to="/external/1" className={linkClass}>외포장-1</NavLink>
          <NavLink to="/external/2" className={linkClass}>외포장-2</NavLink>
          <NavLink to="/external/3" className={linkClass}>외포장-3</NavLink>
          <NavLink to="/remaining" className={linkClass}>잔여량</NavLink>
          <NavLink to="/analytics" className={linkClass}>분석</NavLink>
        </nav>
      </div>
    </header>
  );
}
