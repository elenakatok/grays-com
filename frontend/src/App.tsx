import { BrowserRouter, Routes, Route } from 'react-router-dom'
import Play from './pages/Play.tsx'
import Configure from './pages/Configure.tsx'
import InstructorDashboard from './pages/InstructorDashboard.tsx'
import StandaloneLogin from './pages/StandaloneLogin.tsx'

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

        {/* Standalone entry (no classroom JWT) */}
        <Route path="/" element={<StandaloneLogin />} />
      </Routes>
    </BrowserRouter>
  )
}
