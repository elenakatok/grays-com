import { useEffect, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { getGameConfig, updateGameConfig, type InstructorDevArgs } from '../api'
import { parsePrice } from '../utils/parsePrice'

// ── Formatting ────────────────────────────────────────────────────────────────

const USD = new Intl.NumberFormat('en-US', {
  style: 'currency', currency: 'USD', maximumFractionDigits: 0,
})

// ── URL validation ────────────────────────────────────────────────────────────

/** Empty string is allowed (field intentionally unset). Non-empty must be http(s). */
function validateUrl(val: string): string | null {
  const v = val.trim()
  if (v === '') return null   // valid — field intentionally empty
  try {
    const parsed = new URL(v)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return 'Must be an http(s) URL (e.g. https://dropbox.com/…)'
    }
    return null
  } catch {
    return 'Enter a valid URL (e.g. https://dropbox.com/…) or leave blank to unset.'
  }
}

// ── Settings page ─────────────────────────────────────────────────────────────

/**
 * Instructor Settings page for a game instance.
 * Reached via /settings?_dev_game_instance_id=<uuid> in dev mode,
 * or a classroom JWT in production (matching /dashboard + /reports convention).
 *
 * Slice (a): reservation-price section.
 * Slice (b): PDF info-links section.
 * Future slices will add the question editor.
 */
export default function Settings() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const gameInstanceId = import.meta.env.DEV
    ? searchParams.get('_dev_game_instance_id')
    : null

  // ── Config load ───────────────────────────────────────────────────
  const [loadError, setLoadError] = useState<string | null>(null)
  const [loading, setLoading]     = useState(false)

  // ── Reservation-price field state ─────────────────────────────────
  const [chrisRaw, setChrisRaw]     = useState('')
  const [kellyRaw, setKellyRaw]     = useState('')
  const [savedChris, setSavedChris] = useState<number | null>(null)
  const [savedKelly, setSavedKelly] = useState<number | null>(null)

  // Per-field "confirm bare number" proposed values (parsePrice kind:'confirm')
  const [confirmChris, setConfirmChris] = useState<number | null>(null)
  const [confirmKelly, setConfirmKelly] = useState<number | null>(null)

  // ── Reservation-price save state ──────────────────────────────────
  const [saving, setSaving]         = useState(false)
  const [saveError, setSaveError]   = useState<string | null>(null)
  const [savedAt, setSavedAt]       = useState<Date | null>(null)
  const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // ── Info-URL field state ──────────────────────────────────────────
  const [publicUrl, setPublicUrl]   = useState('')
  const [chrisUrl,  setChrisUrl]    = useState('')
  const [kellyUrl,  setKellyUrl]    = useState('')

  const [savedPublicUrl, setSavedPublicUrl] = useState<string | null>(null)
  const [savedChrisUrl,  setSavedChrisUrl]  = useState<string | null>(null)
  const [savedKellyUrl,  setSavedKellyUrl]  = useState<string | null>(null)

  // ── Info-URL save state ───────────────────────────────────────────
  const [urlSaving, setUrlSaving]       = useState(false)
  const [urlSaveError, setUrlSaveError] = useState<string | null>(null)
  const [urlSavedAt, setUrlSavedAt]     = useState<Date | null>(null)
  const urlSavedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // ── Load config on mount ──────────────────────────────────────────
  useEffect(() => {
    if (!gameInstanceId) return
    setLoading(true)
    setLoadError(null)
    const args: InstructorDevArgs = { _dev: { game_instance_id: gameInstanceId } }
    getGameConfig(args)
      .then((cfg) => {
        setChrisRaw(String(cfg.reservation_price_chris))
        setKellyRaw(String(cfg.reservation_price_kelly))
        setSavedChris(cfg.reservation_price_chris)
        setSavedKelly(cfg.reservation_price_kelly)
        setPublicUrl(cfg.public_info_url)
        setChrisUrl(cfg.chris_info_url)
        setKellyUrl(cfg.kelly_info_url)
        setSavedPublicUrl(cfg.public_info_url)
        setSavedChrisUrl(cfg.chris_info_url)
        setSavedKellyUrl(cfg.kelly_info_url)
        setLoading(false)
      })
      .catch((err: unknown) => {
        setLoadError(err instanceof Error ? err.message : 'Failed to load config.')
        setLoading(false)
      })
  }, [gameInstanceId])

  // ── Reservation-price save ────────────────────────────────────────

  const applyConfigResult = (cfg: Awaited<ReturnType<typeof getGameConfig>>) => {
    setChrisRaw(String(cfg.reservation_price_chris))
    setKellyRaw(String(cfg.reservation_price_kelly))
    setSavedChris(cfg.reservation_price_chris)
    setSavedKelly(cfg.reservation_price_kelly)
    setPublicUrl(cfg.public_info_url)
    setChrisUrl(cfg.chris_info_url)
    setKellyUrl(cfg.kelly_info_url)
    setSavedPublicUrl(cfg.public_info_url)
    setSavedChrisUrl(cfg.chris_info_url)
    setSavedKellyUrl(cfg.kelly_info_url)
  }

  const handleSave = () => {
    setConfirmChris(null)
    setConfirmKelly(null)
    setSaveError(null)

    const chrisResult = parsePrice(chrisRaw)
    const kellyResult = parsePrice(kellyRaw)

    if (chrisResult.kind === 'invalid') {
      setSaveError('Chris reservation price: enter a valid dollar amount (e.g. 25000 or 25k).')
      return
    }
    if (kellyResult.kind === 'invalid') {
      setSaveError('Kelly reservation price: enter a valid dollar amount (e.g. 475000 or 475k).')
      return
    }
    if (chrisResult.kind === 'confirm') {
      setConfirmChris(chrisResult.proposed)
      return
    }
    if (kellyResult.kind === 'confirm') {
      setConfirmKelly(kellyResult.proposed)
      return
    }

    doSavePrices(chrisResult.value, kellyResult.value)
  }

  const handleConfirmChris = () => {
    if (confirmChris == null) return
    const kellyResult = parsePrice(kellyRaw)
    if (kellyResult.kind === 'confirm') {
      setConfirmChris(null)
      setConfirmKelly(kellyResult.proposed)
      return
    }
    if (kellyResult.kind === 'invalid') {
      setConfirmChris(null)
      setSaveError('Kelly reservation price: enter a valid dollar amount.')
      return
    }
    doSavePrices(confirmChris, kellyResult.value)
    setConfirmChris(null)
  }

  const handleConfirmKelly = () => {
    if (confirmKelly == null) return
    const chrisResult = parsePrice(chrisRaw)
    if (chrisResult.kind === 'invalid') {
      setConfirmKelly(null)
      setSaveError('Chris reservation price: enter a valid dollar amount.')
      return
    }
    const chrisValue = chrisResult.kind === 'confirm' ? chrisResult.proposed : chrisResult.value
    doSavePrices(chrisValue, confirmKelly)
    setConfirmKelly(null)
  }

  const doSavePrices = (chris: number, kelly: number) => {
    if (!gameInstanceId) return
    setSaving(true)
    setSaveError(null)
    if (savedTimerRef.current) clearTimeout(savedTimerRef.current)
    setSavedAt(null)
    const args: InstructorDevArgs = { _dev: { game_instance_id: gameInstanceId } }
    updateGameConfig(args, { reservation_price_chris: chris, reservation_price_kelly: kelly })
      .then((cfg) => {
        setSaving(false)
        applyConfigResult(cfg)
        setSavedAt(new Date())
      })
      .catch((err: unknown) => {
        setSaving(false)
        setSaveError(err instanceof Error ? err.message : 'Save failed — please try again.')
      })
  }

  // ── Info-URL save ─────────────────────────────────────────────────

  const handleUrlSave = () => {
    setUrlSaveError(null)

    const pubErr    = validateUrl(publicUrl)
    const chrisErr  = validateUrl(chrisUrl)
    const kellyErr  = validateUrl(kellyUrl)

    if (pubErr)   { setUrlSaveError(`Public info URL: ${pubErr}`);   return }
    if (chrisErr) { setUrlSaveError(`Chris info URL: ${chrisErr}`);  return }
    if (kellyErr) { setUrlSaveError(`Kelly info URL: ${kellyErr}`);  return }

    if (!gameInstanceId) return
    setUrlSaving(true)
    if (urlSavedTimerRef.current) clearTimeout(urlSavedTimerRef.current)
    setUrlSavedAt(null)
    const args: InstructorDevArgs = { _dev: { game_instance_id: gameInstanceId } }
    updateGameConfig(args, {
      public_info_url: publicUrl.trim(),
      chris_info_url:  chrisUrl.trim(),
      kelly_info_url:  kellyUrl.trim(),
    })
      .then((cfg) => {
        setUrlSaving(false)
        applyConfigResult(cfg)
        setUrlSavedAt(new Date())
      })
      .catch((err: unknown) => {
        setUrlSaving(false)
        setUrlSaveError(err instanceof Error ? err.message : 'Save failed — please try again.')
      })
  }

  // ── Shared helpers ────────────────────────────────────────────────

  const dashLink = gameInstanceId
    ? `/dashboard?_dev_game_instance_id=${gameInstanceId}`
    : '/dashboard'

  const sectionLabel: React.CSSProperties = {
    fontSize: '0.75rem', fontWeight: 700, color: '#94a3b8',
    letterSpacing: '0.08em', textTransform: 'uppercase',
    margin: '0 0 0.875rem',
  }

  const fieldLabel: React.CSSProperties = {
    display: 'block', fontSize: '0.8rem', fontWeight: 600,
    color: '#374151', marginBottom: '0.3rem',
  }

  const inputStyle: React.CSSProperties = {
    width: '100%', padding: '0.55rem 0.75rem', fontSize: '0.95rem',
    border: '1px solid #cbd5e1', borderRadius: 5, fontFamily: 'inherit',
    boxSizing: 'border-box',
  }

  const saveRowStyle: React.CSSProperties = {
    marginTop: '1.125rem', display: 'flex', alignItems: 'center', gap: '0.875rem',
  }

  const saveBtn = (busy: boolean, dis: boolean): React.CSSProperties => ({
    fontSize: '0.875rem', padding: '0.45rem 1.25rem',
    background: dis ? '#94a3b8' : '#1a1a1a',
    color: '#fff', border: 'none', borderRadius: 5,
    cursor: dis ? 'not-allowed' : 'pointer',
    transition: 'background 0.13s',
    opacity: busy ? 0.8 : 1,
  })

  const disabled    = saving    || !gameInstanceId
  const urlDisabled = urlSaving || !gameInstanceId

  // ── Render ────────────────────────────────────────────────────────

  return (
    <div style={{ fontFamily: 'sans-serif', minHeight: '100vh', background: '#f8fafc' }}>

      {/* ── Top bar ────────────────────────────────────────────── */}
      <div style={{ background: '#fff', borderBottom: '1px solid #e0e0e0', padding: '0.625rem 2rem' }}>
        <div style={{ maxWidth: 760, margin: '0 auto', display: 'flex', alignItems: 'center', gap: '1.25rem' }}>
          <button onClick={() => navigate(dashLink)} style={{ fontSize: '0.875rem', padding: '0.3rem 0.75rem' }}>
            ← Dashboard
          </button>
          <h1 style={{ margin: 0, fontSize: '1.125rem', fontWeight: 600 }}>Settings — Grays.com</h1>
        </div>
      </div>

      {/* ── Main ───────────────────────────────────────────────── */}
      <main style={{ maxWidth: 760, margin: '0 auto', padding: '2rem' }}>

        {!gameInstanceId && (
          <p style={{ color: '#94a3b8' }}>Navigate here from the Dashboard to configure this game instance.</p>
        )}
        {loading && <p style={{ color: '#64748b' }}>Loading…</p>}
        {loadError && <p style={{ color: '#dc2626' }}>{loadError}</p>}

        {/* ── Reservation Prices ─────────────────────────────── */}
        <section>
          <p style={sectionLabel}>Reservation Prices</p>

          {/* PDF-desync warning — static, always visible */}
          <div style={{
            background: '#fffbeb', border: '1px solid #fbbf24', borderRadius: 6,
            padding: '0.75rem 1rem', marginBottom: '1.25rem',
            display: 'flex', gap: '0.625rem', alignItems: 'flex-start',
          }}>
            <span style={{ fontSize: '1rem', lineHeight: 1, flexShrink: 0, marginTop: 2 }}>⚠️</span>
            <div style={{ fontSize: '0.825rem', color: '#92400e', lineHeight: 1.5 }}>
              <strong>Role PDFs are the source of truth.</strong>
              {' '}The standard scenario PDFs specify{' '}
              <strong>$25,000</strong> (Chris's floor — cost to switch domains) and{' '}
              <strong>$475,000</strong> (Kelly's ceiling — 1% of $47.5M ticket sales).
              Overriding these values here will <em>desync</em> the numbers students actually read
              in their role sheets. If you change these prices you must also update the PDFs, otherwise
              students will be scored against numbers they were never given.
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1.25rem', maxWidth: 480 }}>

            {/* Chris price */}
            <div>
              <label style={fieldLabel} htmlFor="price-chris">
                Chris — reservation price
              </label>
              <input
                id="price-chris"
                type="text"
                inputMode="decimal"
                value={chrisRaw}
                onChange={(e) => { setChrisRaw(e.target.value); setConfirmChris(null); setSaveError(null) }}
                disabled={disabled}
                placeholder="e.g. 25000"
                style={inputStyle}
              />
              {savedChris != null && (
                <p style={{ margin: '0.25rem 0 0', fontSize: '0.72rem', color: '#6b7280' }}>
                  Saved: {USD.format(savedChris)}
                </p>
              )}
              {confirmChris != null && (
                <div style={{ marginTop: '0.5rem', padding: '0.5rem 0.625rem', background: '#f0f7ff', border: '1px solid #b3d4f5', borderRadius: 4 }}>
                  <p style={{ margin: '0 0 0.4rem', fontSize: '0.8rem' }}>
                    You entered <strong>{USD.format(confirmChris)}</strong>. Is that correct?
                  </p>
                  <div style={{ display: 'flex', gap: '0.375rem' }}>
                    <button onClick={handleConfirmChris} style={{ fontSize: '0.8rem', padding: '0.3rem 0.75rem', background: '#1a1a1a', color: '#fff', border: 'none', borderRadius: 4, cursor: 'pointer' }}>Yes</button>
                    <button onClick={() => setConfirmChris(null)} style={{ fontSize: '0.8rem', padding: '0.3rem 0.625rem', background: 'none', border: '1px solid #ccc', borderRadius: 4, cursor: 'pointer' }}>No</button>
                  </div>
                </div>
              )}
            </div>

            {/* Kelly price */}
            <div>
              <label style={fieldLabel} htmlFor="price-kelly">
                Kelly — reservation price
              </label>
              <input
                id="price-kelly"
                type="text"
                inputMode="decimal"
                value={kellyRaw}
                onChange={(e) => { setKellyRaw(e.target.value); setConfirmKelly(null); setSaveError(null) }}
                disabled={disabled}
                placeholder="e.g. 475000"
                style={inputStyle}
              />
              {savedKelly != null && (
                <p style={{ margin: '0.25rem 0 0', fontSize: '0.72rem', color: '#6b7280' }}>
                  Saved: {USD.format(savedKelly)}
                </p>
              )}
              {confirmKelly != null && (
                <div style={{ marginTop: '0.5rem', padding: '0.5rem 0.625rem', background: '#f0f7ff', border: '1px solid #b3d4f5', borderRadius: 4 }}>
                  <p style={{ margin: '0 0 0.4rem', fontSize: '0.8rem' }}>
                    You entered <strong>{USD.format(confirmKelly)}</strong>. Is that correct?
                  </p>
                  <div style={{ display: 'flex', gap: '0.375rem' }}>
                    <button onClick={handleConfirmKelly} style={{ fontSize: '0.8rem', padding: '0.3rem 0.75rem', background: '#1a1a1a', color: '#fff', border: 'none', borderRadius: 4, cursor: 'pointer' }}>Yes</button>
                    <button onClick={() => setConfirmKelly(null)} style={{ fontSize: '0.8rem', padding: '0.3rem 0.625rem', background: 'none', border: '1px solid #ccc', borderRadius: 4, cursor: 'pointer' }}>No</button>
                  </div>
                </div>
              )}
            </div>
          </div>

          <div style={saveRowStyle}>
            <button onClick={handleSave} disabled={disabled} style={saveBtn(saving, disabled)}>
              {saving ? 'Saving…' : 'Save'}
            </button>
            {savedAt != null && !saving && (
              <span style={{ fontSize: '0.8rem', color: '#16a34a' }}>
                Saved {savedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
              </span>
            )}
            {saveError && <span style={{ fontSize: '0.8rem', color: '#dc2626' }}>{saveError}</span>}
          </div>
        </section>

        {/* ── PDF Info Links ─────────────────────────────────── */}
        <section style={{ marginTop: '2rem' }}>
          <p style={sectionLabel}>PDF Info Links</p>
          <p style={{ margin: '0 0 1.125rem', fontSize: '0.825rem', color: '#64748b', lineHeight: 1.5 }}>
            URLs students receive when they tap "View role materials." Leave a field blank to keep it
            unset. The platform never hosts files — link to your own Dropbox or Drive PDF.
          </p>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', maxWidth: 560 }}>

            {/* Public info */}
            <div>
              <label style={fieldLabel} htmlFor="url-public">
                Public info sheet
                <span style={{ fontWeight: 400, color: '#9ca3af', marginLeft: '0.4rem' }}>
                  — visible to all participants (shared scenario background)
                </span>
              </label>
              <input
                id="url-public"
                type="url"
                value={publicUrl}
                onChange={(e) => { setPublicUrl(e.target.value); setUrlSaveError(null) }}
                disabled={urlDisabled}
                placeholder="https://www.dropbox.com/…"
                style={inputStyle}
              />
              {savedPublicUrl != null && (
                <p style={{ margin: '0.25rem 0 0', fontSize: '0.72rem', color: '#6b7280' }}>
                  {savedPublicUrl ? <>Saved: <span style={{ fontFamily: 'monospace' }}>{savedPublicUrl}</span></> : 'Saved: (not set)'}
                </p>
              )}
            </div>

            {/* Chris role info */}
            <div>
              <label style={fieldLabel} htmlFor="url-chris">
                Chris role info
                <span style={{ fontWeight: 400, color: '#9ca3af', marginLeft: '0.4rem' }}>
                  — private PDF shown only to Chris participants
                </span>
              </label>
              <input
                id="url-chris"
                type="url"
                value={chrisUrl}
                onChange={(e) => { setChrisUrl(e.target.value); setUrlSaveError(null) }}
                disabled={urlDisabled}
                placeholder="https://www.dropbox.com/…"
                style={inputStyle}
              />
              {savedChrisUrl != null && (
                <p style={{ margin: '0.25rem 0 0', fontSize: '0.72rem', color: '#6b7280' }}>
                  {savedChrisUrl ? <>Saved: <span style={{ fontFamily: 'monospace' }}>{savedChrisUrl}</span></> : 'Saved: (not set)'}
                </p>
              )}
            </div>

            {/* Kelly role info */}
            <div>
              <label style={fieldLabel} htmlFor="url-kelly">
                Kelly role info
                <span style={{ fontWeight: 400, color: '#9ca3af', marginLeft: '0.4rem' }}>
                  — private PDF shown only to Kelly participants
                </span>
              </label>
              <input
                id="url-kelly"
                type="url"
                value={kellyUrl}
                onChange={(e) => { setKellyUrl(e.target.value); setUrlSaveError(null) }}
                disabled={urlDisabled}
                placeholder="https://www.dropbox.com/…"
                style={inputStyle}
              />
              {savedKellyUrl != null && (
                <p style={{ margin: '0.25rem 0 0', fontSize: '0.72rem', color: '#6b7280' }}>
                  {savedKellyUrl ? <>Saved: <span style={{ fontFamily: 'monospace' }}>{savedKellyUrl}</span></> : 'Saved: (not set)'}
                </p>
              )}
            </div>
          </div>

          <div style={saveRowStyle}>
            <button onClick={handleUrlSave} disabled={urlDisabled} style={saveBtn(urlSaving, urlDisabled)}>
              {urlSaving ? 'Saving…' : 'Save'}
            </button>
            {urlSavedAt != null && !urlSaving && (
              <span style={{ fontSize: '0.8rem', color: '#16a34a' }}>
                Saved {urlSavedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
              </span>
            )}
            {urlSaveError && <span style={{ fontSize: '0.8rem', color: '#dc2626' }}>{urlSaveError}</span>}
          </div>
        </section>

        {/* ── Debrief Questions (future slice) ───────────────── */}
        <section style={{ marginTop: '2rem' }}>
          <p style={sectionLabel}>Debrief Questions</p>
          <p style={{ margin: 0, fontSize: '0.875rem', color: '#94a3b8' }}>
            Coming soon — configure the open-text debrief prompt that feeds the AI-Analysis Export.
          </p>
        </section>

      </main>
    </div>
  )
}
