/**
 * Live instructor dashboard.
 * Reached via classroom-launched JWT (role: "instructor") from /play,
 * or directly via /dashboard for standalone mode.
 *
 * Sections (per game spec Section 4):
 *   1. Preparation status — who has completed Phase 1
 *   2. Attendance — current code, verified-present count
 *   3. Match Now — trigger matching algorithm
 *   4. Live status — per-group progress
 *   5. Results — final outcomes and distribution
 *   6. Finalize — compute z-scores and push to classroom
 */
export default function InstructorDashboard() {
  return (
    <main style={{ padding: '2rem', maxWidth: '1200px', margin: '0 auto' }}>
      <h1>Instructor Dashboard — Grays.com</h1>
      <p>Dashboard not yet implemented.</p>
    </main>
  )
}
