import { BrowserRouter, Routes, Route } from 'react-router-dom'
import Play from './pages/Play.tsx'
import Configure from './pages/Configure.tsx'
import InstructorDashboard from './pages/InstructorDashboard.tsx'
import StandaloneLogin from './pages/StandaloneLogin.tsx'
import DevLauncher from './pages/DevLauncher.tsx'

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        {/* Classroom-launched entry point — ?token=<JWT> */}
        <Route path="/play" element={<Play />} />

        {/* Instructor configuration, called from classroom — ?token=<JWT> */}
        <Route path="/configure" element={<Configure />} />

        {/* Instructor live dashboard */}
        <Route path="/dashboard" element={<InstructorDashboard />} />

        {/*
          Dev-only test launcher. The route is only added in dev mode;
          import.meta.env.DEV is replaced with `false` at production build
          time so this branch (and the DevLauncher component) is dead code
          and tree-shaken. The component also guards itself internally.
        */}
        {import.meta.env.DEV && (
          <Route path="/dev-launcher" element={<DevLauncher />} />
        )}

        {/* Standalone entry (no classroom JWT) */}
        <Route path="/" element={<StandaloneLogin />} />
      </Routes>
    </BrowserRouter>
  )
}
