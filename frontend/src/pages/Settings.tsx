import { useEffect, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import {
  getGameConfig, updateGameConfig,
  type InstructorDevArgs, type PrepTextQuestion,
} from '../api'
import { parsePrice } from '../utils/parsePrice'

// ── Formatting ────────────────────────────────────────────────────────────────

const USD = new Intl.NumberFormat('en-US', {
  style: 'currency', currency: 'USD', maximumFractionDigits: 0,
})

// ── URL validation ────────────────────────────────────────────────────────────

function validateUrl(val: string): string | null {
  const v = val.trim()
  if (v === '') return null
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

// ── Prep questions helpers ────────────────────────────────────────────────────

/** Normalise order values for text questions to even integers (0, 2, 4 …)
 *  preserving relative position and leaving odd slots for the hardcoded
 *  numeric questions at order 1 and 3. */
function normaliseOrders(qs: PrepTextQuestion[]): PrepTextQuestion[] {
  return qs.map((q, i) => ({ ...q, order: i * 2 }))
}

function newField(): string {
  return `prep_${Date.now().toString(36)}`
}

// ── Settings page ─────────────────────────────────────────────────────────────

/**
 * Instructor Settings page for a game instance.
 *
 * Slice (a): reservation-price section.
 * Slice (b): PDF info-links section.
 * Slice (c — this slice): Prep Questions editor.
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

  // ── Reservation-price state ───────────────────────────────────────
  const [chrisRaw, setChrisRaw]     = useState('')
  const [kellyRaw, setKellyRaw]     = useState('')
  const [savedChris, setSavedChris] = useState<number | null>(null)
  const [savedKelly, setSavedKelly] = useState<number | null>(null)
  const [confirmChris, setConfirmChris] = useState<number | null>(null)
  const [confirmKelly, setConfirmKelly] = useState<number | null>(null)
  const [saving, setSaving]         = useState(false)
  const [saveError, setSaveError]   = useState<string | null>(null)
  const [savedAt, setSavedAt]       = useState<Date | null>(null)
  const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // ── Info-URL state ────────────────────────────────────────────────
  const [publicUrl, setPublicUrl]   = useState('')
  const [chrisUrl,  setChrisUrl]    = useState('')
  const [kellyUrl,  setKellyUrl]    = useState('')
  const [savedPublicUrl, setSavedPublicUrl] = useState<string | null>(null)
  const [savedChrisUrl,  setSavedChrisUrl]  = useState<string | null>(null)
  const [savedKellyUrl,  setSavedKellyUrl]  = useState<string | null>(null)
  const [urlSaving, setUrlSaving]       = useState(false)
  const [urlSaveError, setUrlSaveError] = useState<string | null>(null)
  const [urlSavedAt, setUrlSavedAt]     = useState<Date | null>(null)
  const urlSavedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // ── Prep-questions state ──────────────────────────────────────────
  // `prepQuestions` is the draft being edited in the UI.
  const [prepQuestions, setPrepQuestions] = useState<PrepTextQuestion[]>([])
  const [prepSaving, setPrepSaving]       = useState(false)
  const [prepSaveError, setPrepSaveError] = useState<string | null>(null)
  const [prepSavedAt, setPrepSavedAt]     = useState<Date | null>(null)

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
        setPrepQuestions([...cfg.prep_text_questions].sort((a, b) => a.order - b.order))
        setLoading(false)
      })
      .catch((err: unknown) => {
        setLoadError(err instanceof Error ? err.message : 'Failed to load config.')
        setLoading(false)
      })
  }, [gameInstanceId])

  // ── Shared helper — apply full config result ──────────────────────
  // Called only from price/URL saves so it doesn't clobber unsaved prep edits.
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
    // Intentionally NOT resetting prepQuestions here — avoids clobbering
    // in-progress edits in the prep section when price/URL are saved.
  }

  // ── Reservation-price save ────────────────────────────────────────

  const handleSave = () => {
    setConfirmChris(null); setConfirmKelly(null); setSaveError(null)
    const cr = parsePrice(chrisRaw), kr = parsePrice(kellyRaw)
    if (cr.kind === 'invalid') { setSaveError('Chris reservation price: enter a valid dollar amount (e.g. 25000 or 25k).'); return }
    if (kr.kind === 'invalid') { setSaveError('Kelly reservation price: enter a valid dollar amount (e.g. 475000 or 475k).'); return }
    if (cr.kind === 'confirm') { setConfirmChris(cr.proposed); return }
    if (kr.kind === 'confirm') { setConfirmKelly(kr.proposed); return }
    doSavePrices(cr.value, kr.value)
  }

  const handleConfirmChris = () => {
    if (confirmChris == null) return
    const kr = parsePrice(kellyRaw)
    if (kr.kind === 'confirm') { setConfirmChris(null); setConfirmKelly(kr.proposed); return }
    if (kr.kind === 'invalid') { setConfirmChris(null); setSaveError('Kelly reservation price: enter a valid dollar amount.'); return }
    doSavePrices(confirmChris, kr.value); setConfirmChris(null)
  }

  const handleConfirmKelly = () => {
    if (confirmKelly == null) return
    const cr = parsePrice(chrisRaw)
    if (cr.kind === 'invalid') { setConfirmKelly(null); setSaveError('Chris reservation price: enter a valid dollar amount.'); return }
    doSavePrices(cr.kind === 'confirm' ? cr.proposed : cr.value, confirmKelly); setConfirmKelly(null)
  }

  const doSavePrices = (chris: number, kelly: number) => {
    if (!gameInstanceId) return
    setSaving(true); setSaveError(null)
    if (savedTimerRef.current) clearTimeout(savedTimerRef.current)
    setSavedAt(null)
    const args: InstructorDevArgs = { _dev: { game_instance_id: gameInstanceId } }
    updateGameConfig(args, { reservation_price_chris: chris, reservation_price_kelly: kelly })
      .then(cfg => { setSaving(false); applyConfigResult(cfg); setSavedAt(new Date()) })
      .catch((err: unknown) => { setSaving(false); setSaveError(err instanceof Error ? err.message : 'Save failed — please try again.') })
  }

  // ── Info-URL save ─────────────────────────────────────────────────

  const handleUrlSave = () => {
    setUrlSaveError(null)
    const pe = validateUrl(publicUrl), ce = validateUrl(chrisUrl), ke = validateUrl(kellyUrl)
    if (pe)  { setUrlSaveError(`Public info URL: ${pe}`);  return }
    if (ce)  { setUrlSaveError(`Chris info URL: ${ce}`);   return }
    if (ke)  { setUrlSaveError(`Kelly info URL: ${ke}`);   return }
    if (!gameInstanceId) return
    setUrlSaving(true)
    if (urlSavedTimerRef.current) clearTimeout(urlSavedTimerRef.current)
    setUrlSavedAt(null)
    const args: InstructorDevArgs = { _dev: { game_instance_id: gameInstanceId } }
    updateGameConfig(args, { public_info_url: publicUrl.trim(), chris_info_url: chrisUrl.trim(), kelly_info_url: kellyUrl.trim() })
      .then(cfg => { setUrlSaving(false); applyConfigResult(cfg); setUrlSavedAt(new Date()) })
      .catch((err: unknown) => { setUrlSaving(false); setUrlSaveError(err instanceof Error ? err.message : 'Save failed — please try again.') })
  }

  // ── Prep-questions CRUD ───────────────────────────────────────────

  const handlePrepAddQuestion = () => {
    setPrepSaveError(null)
    const maxOrder = prepQuestions.reduce((m, q) => Math.max(m, q.order), -2)
    // Next even order value after the current maximum
    const nextOrder = maxOrder < 0 ? 0 : maxOrder + 2
    const newQ: PrepTextQuestion = {
      field:       newField(),
      prompt:      '',
      placeholder: '',
      order:       nextOrder,
      hidden:      false,
      deletable:   true,
    }
    setPrepQuestions(prev => [...prev, newQ])
  }

  const handlePrepEdit = (idx: number, patch: Partial<PrepTextQuestion>) => {
    setPrepSaveError(null)
    setPrepQuestions(prev => prev.map((q, i) => i === idx ? { ...q, ...patch } : q))
  }

  const handlePrepToggleHidden = (idx: number) => {
    setPrepSaveError(null)
    setPrepQuestions(prev => prev.map((q, i) => i === idx ? { ...q, hidden: !q.hidden } : q))
  }

  const handlePrepMoveUp = (idx: number) => {
    if (idx === 0) return
    setPrepSaveError(null)
    setPrepQuestions(prev => {
      const next = [...prev]
      ;[next[idx - 1], next[idx]] = [next[idx], next[idx - 1]]
      return normaliseOrders(next)
    })
  }

  const handlePrepMoveDown = (idx: number) => {
    setPrepSaveError(null)
    setPrepQuestions(prev => {
      if (idx >= prev.length - 1) return prev
      const next = [...prev]
      ;[next[idx], next[idx + 1]] = [next[idx + 1], next[idx]]
      return normaliseOrders(next)
    })
  }

  const handlePrepSave = () => {
    setPrepSaveError(null)
    // Validate: every visible question must have a non-empty prompt
    const emptyPrompt = prepQuestions.findIndex(q => !q.hidden && q.prompt.trim() === '')
    if (emptyPrompt !== -1) {
      setPrepSaveError(`Question ${emptyPrompt + 1} has no prompt text — fill it in or hide it.`)
      return
    }
    if (!gameInstanceId) return
    setPrepSaving(true)
    setPrepSavedAt(null)
    const args: InstructorDevArgs = { _dev: { game_instance_id: gameInstanceId } }
    const normalised = normaliseOrders(prepQuestions)
    updateGameConfig(args, { prep_text_questions: normalised })
      .then(cfg => {
        setPrepSaving(false)
        const saved = [...cfg.prep_text_questions].sort((a, b) => a.order - b.order)
        setPrepQuestions(saved)
        setPrepSavedAt(new Date())
      })
      .catch((err: unknown) => {
        setPrepSaving(false)
        setPrepSaveError(err instanceof Error ? err.message : 'Save failed — please try again.')
      })
  }

  // ── Shared styles ─────────────────────────────────────────────────

  const dashLink = gameInstanceId
    ? `/dashboard?_dev_game_instance_id=${gameInstanceId}`
    : '/dashboard'

  const sectionLabel: React.CSSProperties = {
    fontSize: '0.75rem', fontWeight: 700, color: '#94a3b8',
    letterSpacing: '0.08em', textTransform: 'uppercase', margin: '0 0 0.875rem',
  }

  const fieldLabel: React.CSSProperties = {
    display: 'block', fontSize: '0.8rem', fontWeight: 600, color: '#374151', marginBottom: '0.3rem',
  }

  const inputStyle: React.CSSProperties = {
    width: '100%', padding: '0.55rem 0.75rem', fontSize: '0.95rem',
    border: '1px solid #cbd5e1', borderRadius: 5, fontFamily: 'inherit', boxSizing: 'border-box',
  }

  const saveRowStyle: React.CSSProperties = {
    marginTop: '1.125rem', display: 'flex', alignItems: 'center', gap: '0.875rem',
  }

  const saveBtn = (busy: boolean, dis: boolean): React.CSSProperties => ({
    fontSize: '0.875rem', padding: '0.45rem 1.25rem',
    background: dis ? '#94a3b8' : '#1a1a1a', color: '#fff', border: 'none', borderRadius: 5,
    cursor: dis ? 'not-allowed' : 'pointer', transition: 'background 0.13s', opacity: busy ? 0.8 : 1,
  })

  const disabled    = saving    || !gameInstanceId
  const urlDisabled = urlSaving || !gameInstanceId
  const prepDisabled = prepSaving || !gameInstanceId

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

        {!gameInstanceId && <p style={{ color: '#94a3b8' }}>Navigate here from the Dashboard to configure this game instance.</p>}
        {loading && <p style={{ color: '#64748b' }}>Loading…</p>}
        {loadError && <p style={{ color: '#dc2626' }}>{loadError}</p>}

        {/* ── Reservation Prices ─────────────────────────────── */}
        <section>
          <p style={sectionLabel}>Reservation Prices</p>

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
              <label style={fieldLabel} htmlFor="price-chris">Chris — reservation price</label>
              <input id="price-chris" type="text" inputMode="decimal" value={chrisRaw}
                onChange={e => { setChrisRaw(e.target.value); setConfirmChris(null); setSaveError(null) }}
                disabled={disabled} placeholder="e.g. 25000" style={inputStyle} />
              {savedChris != null && <p style={{ margin: '0.25rem 0 0', fontSize: '0.72rem', color: '#6b7280' }}>Saved: {USD.format(savedChris)}</p>}
              {confirmChris != null && (
                <div style={{ marginTop: '0.5rem', padding: '0.5rem 0.625rem', background: '#f0f7ff', border: '1px solid #b3d4f5', borderRadius: 4 }}>
                  <p style={{ margin: '0 0 0.4rem', fontSize: '0.8rem' }}>You entered <strong>{USD.format(confirmChris)}</strong>. Is that correct?</p>
                  <div style={{ display: 'flex', gap: '0.375rem' }}>
                    <button onClick={handleConfirmChris} style={{ fontSize: '0.8rem', padding: '0.3rem 0.75rem', background: '#1a1a1a', color: '#fff', border: 'none', borderRadius: 4, cursor: 'pointer' }}>Yes</button>
                    <button onClick={() => setConfirmChris(null)} style={{ fontSize: '0.8rem', padding: '0.3rem 0.625rem', background: 'none', border: '1px solid #ccc', borderRadius: 4, cursor: 'pointer' }}>No</button>
                  </div>
                </div>
              )}
            </div>

            {/* Kelly price */}
            <div>
              <label style={fieldLabel} htmlFor="price-kelly">Kelly — reservation price</label>
              <input id="price-kelly" type="text" inputMode="decimal" value={kellyRaw}
                onChange={e => { setKellyRaw(e.target.value); setConfirmKelly(null); setSaveError(null) }}
                disabled={disabled} placeholder="e.g. 475000" style={inputStyle} />
              {savedKelly != null && <p style={{ margin: '0.25rem 0 0', fontSize: '0.72rem', color: '#6b7280' }}>Saved: {USD.format(savedKelly)}</p>}
              {confirmKelly != null && (
                <div style={{ marginTop: '0.5rem', padding: '0.5rem 0.625rem', background: '#f0f7ff', border: '1px solid #b3d4f5', borderRadius: 4 }}>
                  <p style={{ margin: '0 0 0.4rem', fontSize: '0.8rem' }}>You entered <strong>{USD.format(confirmKelly)}</strong>. Is that correct?</p>
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
            {savedAt != null && !saving && <span style={{ fontSize: '0.8rem', color: '#16a34a' }}>Saved {savedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>}
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
            <div>
              <label style={fieldLabel} htmlFor="url-public">
                Public info sheet
                <span style={{ fontWeight: 400, color: '#9ca3af', marginLeft: '0.4rem' }}>— visible to all participants (shared scenario background)</span>
              </label>
              <input id="url-public" type="url" value={publicUrl} onChange={e => { setPublicUrl(e.target.value); setUrlSaveError(null) }}
                disabled={urlDisabled} placeholder="https://www.dropbox.com/…" style={inputStyle} />
              {savedPublicUrl != null && <p style={{ margin: '0.25rem 0 0', fontSize: '0.72rem', color: '#6b7280' }}>{savedPublicUrl ? <>Saved: <span style={{ fontFamily: 'monospace' }}>{savedPublicUrl}</span></> : 'Saved: (not set)'}</p>}
            </div>
            <div>
              <label style={fieldLabel} htmlFor="url-chris">
                Chris role info
                <span style={{ fontWeight: 400, color: '#9ca3af', marginLeft: '0.4rem' }}>— private PDF shown only to Chris participants</span>
              </label>
              <input id="url-chris" type="url" value={chrisUrl} onChange={e => { setChrisUrl(e.target.value); setUrlSaveError(null) }}
                disabled={urlDisabled} placeholder="https://www.dropbox.com/…" style={inputStyle} />
              {savedChrisUrl != null && <p style={{ margin: '0.25rem 0 0', fontSize: '0.72rem', color: '#6b7280' }}>{savedChrisUrl ? <>Saved: <span style={{ fontFamily: 'monospace' }}>{savedChrisUrl}</span></> : 'Saved: (not set)'}</p>}
            </div>
            <div>
              <label style={fieldLabel} htmlFor="url-kelly">
                Kelly role info
                <span style={{ fontWeight: 400, color: '#9ca3af', marginLeft: '0.4rem' }}>— private PDF shown only to Kelly participants</span>
              </label>
              <input id="url-kelly" type="url" value={kellyUrl} onChange={e => { setKellyUrl(e.target.value); setUrlSaveError(null) }}
                disabled={urlDisabled} placeholder="https://www.dropbox.com/…" style={inputStyle} />
              {savedKellyUrl != null && <p style={{ margin: '0.25rem 0 0', fontSize: '0.72rem', color: '#6b7280' }}>{savedKellyUrl ? <>Saved: <span style={{ fontFamily: 'monospace' }}>{savedKellyUrl}</span></> : 'Saved: (not set)'}</p>}
            </div>
          </div>
          <div style={saveRowStyle}>
            <button onClick={handleUrlSave} disabled={urlDisabled} style={saveBtn(urlSaving, urlDisabled)}>
              {urlSaving ? 'Saving…' : 'Save'}
            </button>
            {urlSavedAt != null && !urlSaving && <span style={{ fontSize: '0.8rem', color: '#16a34a' }}>Saved {urlSavedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>}
            {urlSaveError && <span style={{ fontSize: '0.8rem', color: '#dc2626' }}>{urlSaveError}</span>}
          </div>
        </section>

        {/* ── Prep Questions ─────────────────────────────────── */}
        <section style={{ marginTop: '2rem' }}>
          <p style={sectionLabel}>Prep Questions</p>
          <p style={{ margin: '0 0 1rem', fontSize: '0.825rem', color: '#64748b', lineHeight: 1.5 }}>
            Free-text questions shown to students during the preparation phase (before the negotiation).
            Hidden questions are skipped but their existing responses are preserved.
            The two numeric questions (estimated reservation price, planned first offer) are fixed and
            always appear between the first/second and second/third text questions.
          </p>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.875rem', maxWidth: 640 }}>
            {prepQuestions.map((q, idx) => (
              <div key={q.field} style={{
                border: `1px solid ${q.hidden ? '#e2e8f0' : '#cbd5e1'}`,
                borderRadius: 7, padding: '0.875rem',
                background: q.hidden ? '#f8fafc' : '#fff',
                opacity: q.hidden ? 0.65 : 1,
              }}>
                {/* Row header */}
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.625rem' }}>
                  <span style={{ fontSize: '0.7rem', fontWeight: 700, color: '#94a3b8', minWidth: 20 }}>
                    {idx + 1}
                  </span>

                  {/* Up / Down */}
                  <button
                    onClick={() => handlePrepMoveUp(idx)}
                    disabled={prepDisabled || idx === 0}
                    title="Move up"
                    style={{ fontSize: '0.75rem', padding: '0.15rem 0.375rem', cursor: idx === 0 || prepDisabled ? 'default' : 'pointer', opacity: idx === 0 ? 0.3 : 1 }}
                  >↑</button>
                  <button
                    onClick={() => handlePrepMoveDown(idx)}
                    disabled={prepDisabled || idx === prepQuestions.length - 1}
                    title="Move down"
                    style={{ fontSize: '0.75rem', padding: '0.15rem 0.375rem', cursor: idx === prepQuestions.length - 1 || prepDisabled ? 'default' : 'pointer', opacity: idx === prepQuestions.length - 1 ? 0.3 : 1 }}
                  >↓</button>

                  <span style={{ fontSize: '0.68rem', fontFamily: 'monospace', color: '#94a3b8', flex: 1 }}>
                    {q.field}
                  </span>

                  {/* Hide / Show */}
                  <button
                    onClick={() => handlePrepToggleHidden(idx)}
                    disabled={prepDisabled}
                    title={q.hidden ? 'Show to students' : 'Hide from students'}
                    style={{ fontSize: '0.75rem', padding: '0.2rem 0.5rem', cursor: prepDisabled ? 'not-allowed' : 'pointer' }}
                  >
                    {q.hidden ? '🚫 Hidden' : '👁 Visible'}
                  </button>

                </div>

                {/* Prompt */}
                <label style={{ ...fieldLabel, marginBottom: '0.25rem' }}>
                  Question prompt
                </label>
                <textarea
                  value={q.prompt}
                  onChange={e => handlePrepEdit(idx, { prompt: e.target.value })}
                  disabled={prepDisabled}
                  rows={2}
                  placeholder="Enter the question students will see…"
                  style={{
                    width: '100%', padding: '0.5rem 0.625rem', fontSize: '0.9rem',
                    border: '1px solid #cbd5e1', borderRadius: 4, fontFamily: 'inherit',
                    resize: 'vertical', boxSizing: 'border-box',
                  }}
                />

                {/* Placeholder */}
                <label style={{ ...fieldLabel, marginTop: '0.5rem', marginBottom: '0.2rem' }}>
                  Placeholder hint <span style={{ fontWeight: 400, color: '#9ca3af' }}>(optional)</span>
                </label>
                <input
                  type="text"
                  value={q.placeholder}
                  onChange={e => handlePrepEdit(idx, { placeholder: e.target.value })}
                  disabled={prepDisabled}
                  placeholder="e.g. Think about the other side's perspective…"
                  style={{ ...inputStyle, fontSize: '0.875rem', padding: '0.4rem 0.625rem' }}
                />
              </div>
            ))}
          </div>

          {/* Add question */}
          <button
            onClick={handlePrepAddQuestion}
            disabled={prepDisabled}
            style={{
              marginTop: '0.875rem', fontSize: '0.875rem', padding: '0.4rem 0.875rem',
              background: 'none', border: '1px solid #94a3b8', borderRadius: 5, color: '#475569',
              cursor: prepDisabled ? 'not-allowed' : 'pointer',
            }}
          >
            + Add question
          </button>

          <div style={saveRowStyle}>
            <button onClick={handlePrepSave} disabled={prepDisabled} style={saveBtn(prepSaving, prepDisabled)}>
              {prepSaving ? 'Saving…' : 'Save'}
            </button>
            {prepSavedAt != null && !prepSaving && <span style={{ fontSize: '0.8rem', color: '#16a34a' }}>Saved {prepSavedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>}
            {prepSaveError && <span style={{ fontSize: '0.8rem', color: '#dc2626' }}>{prepSaveError}</span>}
          </div>
        </section>

      </main>
    </div>
  )
}
