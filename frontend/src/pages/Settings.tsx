import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import {
  getGameConfig, updateGameConfig,
  CLASSROOM_URL, isAuthError,
  type InstructorCallArgs, type PrepTextQuestion, type MCOption,
} from '../api'
import { parsePrice } from '../utils/parsePrice'
import GameHeader from '../components/GameHeader'

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

/** Reassigns sequential order values (0, 1, 2 …) across all question types. */
function normaliseOrders(qs: PrepTextQuestion[]): PrepTextQuestion[] {
  return qs.map((q, i) => ({ ...q, order: i }))
}

function newField(): string {
  return `prep_${Date.now().toString(36)}`
}

function newKCField(): string {
  return `kc_${Date.now().toString(36)}`
}

/** Converts a label string into a URL-safe slug for use as an option value. */
function slugify(s: string): string {
  return s.toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40)
}

// ── Icons ─────────────────────────────────────────────────────────────────────

function EyeIcon({ slashed }: { slashed: boolean }) {
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
      aria-hidden="true">
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
      <circle cx="12" cy="12" r="3" />
      {slashed && <line x1="2" y1="2" x2="22" y2="22" />}
    </svg>
  )
}

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
      aria-hidden="true">
      <polyline points={open ? '18 15 12 9 6 15' : '6 9 12 15 18 9'} />
    </svg>
  )
}

// ── Settings page ─────────────────────────────────────────────────────────────

export default function Settings() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()

  const devGameInstanceId = import.meta.env.DEV
    ? searchParams.get('_dev_game_instance_id')
    : null
  const tokenParam          = searchParams.get('token')
  const gameInstanceIdParam = searchParams.get('game_instance_id')

  const callArgs = useMemo<InstructorCallArgs | null>(() => {
    if (devGameInstanceId) return { _dev: { game_instance_id: devGameInstanceId } }
    if (tokenParam) return { token: tokenParam }
    return null
  }, [devGameInstanceId, tokenParam])

  const makeLink = (base: string): string => {
    if (devGameInstanceId) return `${base}?_dev_game_instance_id=${encodeURIComponent(devGameInstanceId)}`
    if (tokenParam && gameInstanceIdParam)
      return `${base}?token=${encodeURIComponent(tokenParam)}&game_instance_id=${encodeURIComponent(gameInstanceIdParam)}`
    return base
  }

  // ── Config load ───────────────────────────────────────────────────
  const [loadError, setLoadError] = useState<string | null>(null)
  const [authError, setAuthError] = useState<string | null>(null)
  const [loading, setLoading]     = useState(false)

  // ── Display-name state ───────────────────────────────────────────
  const [sellerNameRaw, setSellerNameRaw] = useState('')
  const [buyerNameRaw,  setBuyerNameRaw]  = useState('')
  const [savedSellerName, setSavedSellerName] = useState<string | null>(null)
  const [savedBuyerName,  setSavedBuyerName]  = useState<string | null>(null)
  const [namesSaving, setNamesSaving]     = useState(false)
  const [namesSaveError, setNamesSaveError] = useState<string | null>(null)
  const [namesSavedAt, setNamesSavedAt]   = useState<Date | null>(null)
  const namesSavedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [namesOpen, setNamesOpen] = useState(false)

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
  const [prepQuestions, setPrepQuestions] = useState<PrepTextQuestion[]>([])
  const [prepSaving, setPrepSaving]       = useState(false)
  const [prepSaveError, setPrepSaveError] = useState<string | null>(null)
  const [prepSavedAt, setPrepSavedAt]     = useState<Date | null>(null)

  // ── UI collapse state (all closed by default) ─────────────────────
  const [pricesOpen, setPricesOpen] = useState(false)
  const [linksOpen,  setLinksOpen]  = useState(false)
  const [prepOpen,   setPrepOpen]   = useState(false)
  const [expandedQ,  setExpandedQ]  = useState<number | null>(null)

  // ── Load config on mount ──────────────────────────────────────────
  useEffect(() => {
    if (!callArgs) return
    setLoading(true)
    setLoadError(null)
    getGameConfig(callArgs)
      .then((cfg) => {
        setSellerNameRaw(cfg.seller_name)
        setBuyerNameRaw(cfg.buyer_name)
        setSavedSellerName(cfg.seller_name)
        setSavedBuyerName(cfg.buyer_name)
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
        if (isAuthError(err)) {
          setAuthError(err instanceof Error ? err.message : 'Authentication failed.')
        } else {
          setLoadError(err instanceof Error ? err.message : 'Failed to load config.')
        }
        setLoading(false)
      })
  }, [callArgs])

  // ── Shared helper — apply full config result ──────────────────────
  const applyConfigResult = (cfg: Awaited<ReturnType<typeof getGameConfig>>) => {
    setSellerNameRaw(cfg.seller_name)
    setBuyerNameRaw(cfg.buyer_name)
    setSavedSellerName(cfg.seller_name)
    setSavedBuyerName(cfg.buyer_name)
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
    // Intentionally NOT resetting prepQuestions — avoids clobbering in-progress prep edits.
  }

  // ── Reservation-price save ────────────────────────────────────────

  const handleSave = () => {
    setConfirmChris(null); setConfirmKelly(null); setSaveError(null)
    const cr = parsePrice(chrisRaw), kr = parsePrice(kellyRaw)
    if (cr.kind === 'invalid') { setSaveError(`${savedSellerName ?? 'Seller'} reservation price: enter a valid dollar amount (e.g. 25000 or 25k).`); return }
    if (kr.kind === 'invalid') { setSaveError(`${savedBuyerName ?? 'Buyer'} reservation price: enter a valid dollar amount (e.g. 475000 or 475k).`); return }
    if (cr.kind === 'confirm') { setConfirmChris(cr.proposed); return }
    if (kr.kind === 'confirm') { setConfirmKelly(kr.proposed); return }
    doSavePrices(cr.value, kr.value)
  }

  const handleConfirmChris = () => {
    if (confirmChris == null) return
    const kr = parsePrice(kellyRaw)
    if (kr.kind === 'confirm') { setConfirmChris(null); setConfirmKelly(kr.proposed); return }
    if (kr.kind === 'invalid') { setConfirmChris(null); setSaveError(`${savedBuyerName ?? 'Buyer'} reservation price: enter a valid dollar amount.`); return }
    doSavePrices(confirmChris, kr.value); setConfirmChris(null)
  }

  const handleConfirmKelly = () => {
    if (confirmKelly == null) return
    const cr = parsePrice(chrisRaw)
    if (cr.kind === 'invalid') { setConfirmKelly(null); setSaveError(`${savedSellerName ?? 'Seller'} reservation price: enter a valid dollar amount.`); return }
    doSavePrices(cr.kind === 'confirm' ? cr.proposed : cr.value, confirmKelly); setConfirmKelly(null)
  }

  const doSavePrices = (chris: number, kelly: number) => {
    if (!callArgs) return
    setSaving(true); setSaveError(null)
    if (savedTimerRef.current) clearTimeout(savedTimerRef.current)
    setSavedAt(null)
    updateGameConfig(callArgs, { reservation_price_chris: chris, reservation_price_kelly: kelly })
      .then(cfg => { setSaving(false); applyConfigResult(cfg); setSavedAt(new Date()) })
      .catch((err: unknown) => { setSaving(false); setSaveError(err instanceof Error ? err.message : 'Save failed — please try again.') })
  }

  // ── Info-URL save ─────────────────────────────────────────────────

  const handleUrlSave = () => {
    setUrlSaveError(null)
    const pe = validateUrl(publicUrl), ce = validateUrl(chrisUrl), ke = validateUrl(kellyUrl)
    if (pe)  { setUrlSaveError(`Public info URL: ${pe}`);  return }
    if (ce)  { setUrlSaveError(`${savedSellerName ?? 'Seller'} info URL: ${ce}`);  return }
    if (ke)  { setUrlSaveError(`${savedBuyerName  ?? 'Buyer'}  info URL: ${ke}`);  return }
    if (!callArgs) return
    setUrlSaving(true)
    if (urlSavedTimerRef.current) clearTimeout(urlSavedTimerRef.current)
    setUrlSavedAt(null)
    updateGameConfig(callArgs, { public_info_url: publicUrl.trim(), chris_info_url: chrisUrl.trim(), kelly_info_url: kellyUrl.trim() })
      .then(cfg => { setUrlSaving(false); applyConfigResult(cfg); setUrlSavedAt(new Date()) })
      .catch((err: unknown) => { setUrlSaving(false); setUrlSaveError(err instanceof Error ? err.message : 'Save failed — please try again.') })
  }

  // ── Display-name save ─────────────────────────────────────────────

  const handleNamesSave = () => {
    setNamesSaveError(null)
    const sn = sellerNameRaw.trim()
    const bn = buyerNameRaw.trim()
    if (!sn) { setNamesSaveError('Seller name cannot be blank.'); return }
    if (!bn) { setNamesSaveError('Buyer name cannot be blank.'); return }
    if (!callArgs) return
    setNamesSaving(true)
    if (namesSavedTimerRef.current) clearTimeout(namesSavedTimerRef.current)
    setNamesSavedAt(null)
    updateGameConfig(callArgs, { seller_name: sn, buyer_name: bn })
      .then(cfg => { setNamesSaving(false); applyConfigResult(cfg); setNamesSavedAt(new Date()) })
      .catch((err: unknown) => { setNamesSaving(false); setNamesSaveError(err instanceof Error ? err.message : 'Save failed — please try again.') })
  }

  // ── Prep-questions CRUD ───────────────────────────────────────────

  const handlePrepAddQuestion = () => {
    setPrepSaveError(null)
    const maxOrder = prepQuestions.reduce((m, q) => Math.max(m, q.order), -1)
    const newIdx = prepQuestions.length
    const newQ: PrepTextQuestion = {
      field:       newField(),
      type:        'text',
      system:      false,
      category:    'preparation',
      format:      'text',
      role_target: 'both',
      prompt:      '',
      placeholder: '',
      order:       maxOrder + 1,
      hidden:      false,
      deletable:   true,
    }
    setPrepQuestions(prev => [...prev, newQ])
    setExpandedQ(newIdx)
  }

  const handlePrepEdit = (idx: number, patch: Partial<PrepTextQuestion>) => {
    setPrepSaveError(null)
    setPrepQuestions(prev => prev.map((q, i) => i === idx ? { ...q, ...patch } : q))
  }

  const handlePrepAddKCQuestion = () => {
    setPrepSaveError(null)
    const maxOrder = prepQuestions.reduce((m, q) => Math.max(m, q.order), -1)
    const newIdx = prepQuestions.length
    const newQ: PrepTextQuestion = {
      field:       newKCField(),
      type:        'mc',
      system:      false,
      category:    'knowledge_check',
      format:      'multiple_choice',
      grading:     'static',
      role_target: 'both',
      prompt:      '',
      placeholder: '',
      order:       maxOrder + 1,
      hidden:      false,
      deletable:   true,
      options:     [],
    }
    setPrepQuestions(prev => [...prev, newQ])
    setExpandedQ(newIdx)
  }

  const handlePrepOptionLabel = (qIdx: number, optIdx: number, label: string) => {
    setPrepSaveError(null)
    setPrepQuestions(prev => prev.map((q, i) => {
      if (i !== qIdx || !q.options) return q
      const newOptions: MCOption[] = q.options.map((o, oi) => oi === optIdx ? { ...o, label } : o)
      return { ...q, options: newOptions }
    }))
  }

  /** Locks the option value from its label on blur (only for new options with no value yet). */
  const handlePrepOptionBlur = (qIdx: number, optIdx: number) => {
    setPrepQuestions(prev => prev.map((q, i) => {
      if (i !== qIdx || !q.options) return q
      const opt = q.options[optIdx]
      if (opt.value) return q
      const label = opt.label.trim()
      if (!label) return q
      const existingValues = q.options.filter((_, oi) => oi !== optIdx).map(o => o.value).filter(Boolean)
      const slug = slugify(label)
      const value = (slug && !existingValues.includes(slug)) ? slug : `opt_${optIdx + 1}`
      return { ...q, options: q.options.map((o, oi) => oi === optIdx ? { ...o, value } : o) }
    }))
  }

  const handlePrepAddOption = (qIdx: number) => {
    setPrepSaveError(null)
    setPrepQuestions(prev => prev.map((q, i) => {
      if (i !== qIdx) return q
      return { ...q, options: [...(q.options ?? []), { value: '', label: '' }] }
    }))
  }

  const handlePrepCorrectValue = (idx: number, value: string) => {
    setPrepSaveError(null)
    handlePrepEdit(idx, { correct_value: value })
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
    setExpandedQ(eq => eq === idx ? idx - 1 : eq === idx - 1 ? idx : eq)
  }

  const handlePrepMoveDown = (idx: number) => {
    setPrepSaveError(null)
    setPrepQuestions(prev => {
      if (idx >= prev.length - 1) return prev
      const next = [...prev]
      ;[next[idx], next[idx + 1]] = [next[idx + 1], next[idx]]
      return normaliseOrders(next)
    })
    setExpandedQ(eq => eq === idx ? idx + 1 : eq === idx + 1 ? idx : eq)
  }

  const handlePrepSave = () => {
    setPrepSaveError(null)
    const emptyPrompt = prepQuestions.findIndex(q => !q.hidden && q.prompt.trim() === '')
    if (emptyPrompt !== -1) {
      setPrepSaveError(`Question ${emptyPrompt + 1} has no prompt text — fill it in or hide it.`)
      return
    }
    if (!callArgs) return
    setPrepSaving(true)
    setPrepSavedAt(null)
    const normalised = normaliseOrders(prepQuestions)
    updateGameConfig(callArgs, { prep_text_questions: normalised })
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

  const dashLink = makeLink('/dashboard')

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

  const sectionHeaderStyle: React.CSSProperties = {
    width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    padding: '0.75rem 1rem', background: 'none', border: 'none',
    cursor: 'pointer', textAlign: 'left', color: 'inherit',
  }

  const sectionCardStyle = (open: boolean): React.CSSProperties => ({
    border: '1px solid #e2e8f0', borderRadius: 8, overflow: 'hidden',
    background: '#fff', marginTop: '1rem',
    boxShadow: open ? '0 1px 4px rgba(0,0,0,0.06)' : 'none',
  })

  const sectionTitleStyle: React.CSSProperties = {
    fontSize: '0.75rem', fontWeight: 700, color: '#64748b',
    letterSpacing: '0.08em', textTransform: 'uppercase',
  }

  const sectionBodyStyle: React.CSSProperties = {
    padding: '1.25rem 1rem', borderTop: '1px solid #e2e8f0',
  }

  const disabled     = saving       || !callArgs
  const urlDisabled  = urlSaving    || !callArgs
  const prepDisabled = prepSaving   || !callArgs
  const namesDisabled = namesSaving || !callArgs

  // ── Render ────────────────────────────────────────────────────────

  if (authError) {
    return (
      <main style={{ padding: '2rem', maxWidth: '800px', margin: '0 auto', fontFamily: 'sans-serif' }}>
        <div style={{
          background: '#fef2f2',
          border: '1px solid #fca5a5',
          borderRadius: 6,
          padding: '1.25rem 1.5rem',
          color: '#7f1d1d',
        }}>
          <p style={{ margin: '0 0 0.75rem' }}>
            This launch link is invalid or has expired. Launch links are only valid for a short time.
            Please return to the classroom and click &ldquo;Launch&rdquo; again to get a new link.
          </p>
          <a href={CLASSROOM_URL} style={{ color: '#b91c1c', fontWeight: 600 }}>Return to classroom</a>
        </div>
      </main>
    )
  }
  return (
    <div style={{ fontFamily: 'sans-serif', minHeight: '100vh', background: '#f8fafc' }}>
      <GameHeader />

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

        {!callArgs && <p style={{ color: '#c00' }}>No valid launch token. Open this page from the classroom or dashboard.</p>}
        {loading && <p style={{ color: '#64748b' }}>Loading…</p>}
        {loadError && <p style={{ color: '#dc2626' }}>{loadError}</p>}

        {/* ── Display Names ──────────────────────────────────── */}
        <div style={sectionCardStyle(namesOpen)}>
          <button
            style={sectionHeaderStyle}
            onClick={() => setNamesOpen(o => !o)}
            aria-expanded={namesOpen}
          >
            <span style={sectionTitleStyle}>Display Names</span>
            <ChevronIcon open={namesOpen} />
          </button>

          {namesOpen && (
            <div style={sectionBodyStyle}>
              <div style={{
                background: '#fffbeb', border: '1px solid #fbbf24', borderRadius: 6,
                padding: '0.75rem 1rem', marginBottom: '1.25rem',
                display: 'flex', gap: '0.625rem', alignItems: 'flex-start',
              }}>
                <span style={{ fontSize: '1rem', lineHeight: 1, flexShrink: 0, marginTop: 2 }}>⚠️</span>
                <div style={{ fontSize: '0.825rem', color: '#92400e', lineHeight: 1.5 }}>
                  <strong>Role PDFs are the source of truth.</strong>
                  {' '}The role sheets address each participant by name. Changing the seller or buyer
                  display name here will <em>desync</em> the name students read in their role sheets
                  from the name shown in the game. If you change these names you must also update the
                  PDFs, otherwise students will see a different name than the one in their role sheet.
                </div>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1.25rem', maxWidth: 480 }}>
                <div>
                  <label style={fieldLabel} htmlFor="name-seller">Seller display name</label>
                  <input id="name-seller" type="text" value={sellerNameRaw}
                    onChange={e => { setSellerNameRaw(e.target.value); setNamesSaveError(null) }}
                    disabled={namesDisabled} placeholder="e.g. Chris" style={inputStyle} />
                  {savedSellerName != null && <p style={{ margin: '0.25rem 0 0', fontSize: '0.72rem', color: '#6b7280' }}>Saved: {savedSellerName}</p>}
                </div>
                <div>
                  <label style={fieldLabel} htmlFor="name-buyer">Buyer display name</label>
                  <input id="name-buyer" type="text" value={buyerNameRaw}
                    onChange={e => { setBuyerNameRaw(e.target.value); setNamesSaveError(null) }}
                    disabled={namesDisabled} placeholder="e.g. Kelly" style={inputStyle} />
                  {savedBuyerName != null && <p style={{ margin: '0.25rem 0 0', fontSize: '0.72rem', color: '#6b7280' }}>Saved: {savedBuyerName}</p>}
                </div>
              </div>
              <div style={saveRowStyle}>
                <button onClick={handleNamesSave} disabled={namesDisabled} style={saveBtn(namesSaving, namesDisabled)}>
                  {namesSaving ? 'Saving…' : 'Save'}
                </button>
                {namesSavedAt != null && !namesSaving && <span style={{ fontSize: '0.8rem', color: '#16a34a' }}>Saved {namesSavedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>}
                {namesSaveError && <span style={{ fontSize: '0.8rem', color: '#dc2626' }}>{namesSaveError}</span>}
              </div>
            </div>
          )}
        </div>

        {/* ── Reservation Prices ─────────────────────────────── */}
        <div style={sectionCardStyle(pricesOpen)}>
          <button
            style={sectionHeaderStyle}
            onClick={() => setPricesOpen(o => !o)}
            aria-expanded={pricesOpen}
          >
            <span style={sectionTitleStyle}>Reservation Prices</span>
            <ChevronIcon open={pricesOpen} />
          </button>

          {pricesOpen && (
            <div style={sectionBodyStyle}>
              <div style={{
                background: '#fffbeb', border: '1px solid #fbbf24', borderRadius: 6,
                padding: '0.75rem 1rem', marginBottom: '1.25rem',
                display: 'flex', gap: '0.625rem', alignItems: 'flex-start',
              }}>
                <span style={{ fontSize: '1rem', lineHeight: 1, flexShrink: 0, marginTop: 2 }}>⚠️</span>
                <div style={{ fontSize: '0.825rem', color: '#92400e', lineHeight: 1.5 }}>
                  <strong>Role PDFs are the source of truth.</strong>
                  {' '}The role sheets specify the seller&apos;s floor (their walk-away cost) and
                  the buyer&apos;s ceiling (their maximum willingness to pay).
                  Overriding these values here will <em>desync</em> the numbers students actually read
                  in their role sheets. If you change these prices you must also update the PDFs, otherwise
                  students will be scored against numbers they were never given.
                </div>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1.25rem', maxWidth: 480 }}>
                {/* Chris price */}
                <div>
                  <label style={fieldLabel} htmlFor="price-chris">{savedSellerName ?? 'Seller'} — reservation price</label>
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
                  <label style={fieldLabel} htmlFor="price-kelly">{savedBuyerName ?? 'Buyer'} — reservation price</label>
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
            </div>
          )}
        </div>

        {/* ── PDF Info Links ─────────────────────────────────── */}
        <div style={sectionCardStyle(linksOpen)}>
          <button
            style={sectionHeaderStyle}
            onClick={() => setLinksOpen(o => !o)}
            aria-expanded={linksOpen}
          >
            <span style={sectionTitleStyle}>PDF Info Links</span>
            <ChevronIcon open={linksOpen} />
          </button>

          {linksOpen && (
            <div style={sectionBodyStyle}>
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
                    {savedSellerName ?? 'Seller'} role info
                    <span style={{ fontWeight: 400, color: '#9ca3af', marginLeft: '0.4rem' }}>— private PDF shown only to seller participants</span>
                  </label>
                  <input id="url-chris" type="url" value={chrisUrl} onChange={e => { setChrisUrl(e.target.value); setUrlSaveError(null) }}
                    disabled={urlDisabled} placeholder="https://www.dropbox.com/…" style={inputStyle} />
                  {savedChrisUrl != null && <p style={{ margin: '0.25rem 0 0', fontSize: '0.72rem', color: '#6b7280' }}>{savedChrisUrl ? <>Saved: <span style={{ fontFamily: 'monospace' }}>{savedChrisUrl}</span></> : 'Saved: (not set)'}</p>}
                </div>
                <div>
                  <label style={fieldLabel} htmlFor="url-kelly">
                    {savedBuyerName ?? 'Buyer'} role info
                    <span style={{ fontWeight: 400, color: '#9ca3af', marginLeft: '0.4rem' }}>— private PDF shown only to buyer participants</span>
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
            </div>
          )}
        </div>

        {/* ── Prep Questions ─────────────────────────────────── */}
        <div style={sectionCardStyle(prepOpen)}>
          <button
            style={sectionHeaderStyle}
            onClick={() => setPrepOpen(o => !o)}
            aria-expanded={prepOpen}
          >
            <span style={sectionTitleStyle}>Prep Questions</span>
            <ChevronIcon open={prepOpen} />
          </button>

          {prepOpen && (
            <div style={{ ...sectionBodyStyle, padding: '0' }}>

              {/* Question rows */}
              <div>
                {prepQuestions.map((q, idx) => {
                  const isExpanded = expandedQ === idx
                  return (
                    <div
                      key={q.field}
                      style={{ borderTop: idx === 0 ? '1px solid #e2e8f0' : undefined }}
                    >
                      {/* ── Summary row ── */}
                      <div
                        onClick={() => setExpandedQ(eq => eq === idx ? null : idx)}
                        style={{
                          display: 'flex', alignItems: 'center', gap: '0.5rem',
                          padding: '0.55rem 1rem',
                          borderBottom: isExpanded ? '1px solid #e8edf2' : '1px solid #f1f5f9',
                          cursor: 'pointer',
                          background: isExpanded
                            ? (q.system ? '#eef3ff' : '#fafbfc')
                            : (q.hidden ? '#f8fafc' : '#fff'),
                          opacity: q.hidden ? 0.7 : 1,
                          userSelect: 'none',
                        }}
                      >
                        {/* Position */}
                        <span style={{ fontSize: '0.7rem', fontWeight: 700, color: '#94a3b8', minWidth: 16, flexShrink: 0 }}>
                          {idx + 1}
                        </span>

                        {/* Up / Down — stopPropagation so they don't toggle expand */}
                        <button
                          onClick={e => { e.stopPropagation(); handlePrepMoveUp(idx) }}
                          disabled={prepDisabled || idx === 0}
                          title="Move up"
                          style={{
                            fontSize: '0.7rem', padding: '0.1rem 0.3rem', lineHeight: 1,
                            cursor: idx === 0 || prepDisabled ? 'default' : 'pointer',
                            opacity: idx === 0 ? 0.25 : 1,
                            background: 'none', border: '1px solid #e2e8f0', borderRadius: 3,
                            flexShrink: 0,
                          }}
                        >↑</button>
                        <button
                          onClick={e => { e.stopPropagation(); handlePrepMoveDown(idx) }}
                          disabled={prepDisabled || idx === prepQuestions.length - 1}
                          title="Move down"
                          style={{
                            fontSize: '0.7rem', padding: '0.1rem 0.3rem', lineHeight: 1,
                            cursor: idx === prepQuestions.length - 1 || prepDisabled ? 'default' : 'pointer',
                            opacity: idx === prepQuestions.length - 1 ? 0.25 : 1,
                            background: 'none', border: '1px solid #e2e8f0', borderRadius: 3,
                            flexShrink: 0,
                          }}
                        >↓</button>

                        {/* Field name */}
                        <span style={{ fontSize: '0.66rem', fontFamily: 'monospace', color: '#94a3b8', flexShrink: 0 }}>
                          {q.field}
                        </span>

                        {/* Type badge */}
                        <span style={{
                          fontSize: '0.62rem', padding: '0.1rem 0.35rem',
                          background: '#f1f5f9', color: '#64748b', borderRadius: 3, flexShrink: 0,
                        }}>{q.type}</span>

                        {/* Category badge */}
                        <span style={{
                          fontSize: '0.62rem', padding: '0.1rem 0.35rem',
                          background: q.category === 'knowledge_check'
                            ? '#fef3c7' : q.category === 'debrief'
                            ? '#f0fdf4' : '#f5f3ff',
                          color: q.category === 'knowledge_check'
                            ? '#92400e' : q.category === 'debrief'
                            ? '#166534' : '#6d28d9',
                          borderRadius: 3, flexShrink: 0,
                        }}>{q.category}</span>

                        {/* System badge */}
                        {q.system && (
                          <span style={{
                            fontSize: '0.62rem', fontWeight: 700, padding: '0.1rem 0.35rem',
                            background: '#dbeafe', color: '#1d4ed8', borderRadius: 3,
                            letterSpacing: '0.04em', textTransform: 'uppercase', flexShrink: 0,
                          }}>System</span>
                        )}

                        {/* Prompt preview */}
                        <span style={{
                          flex: 1, fontSize: '0.8rem', color: q.prompt ? '#374151' : '#94a3b8',
                          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                          marginLeft: '0.25rem', fontStyle: q.prompt ? 'normal' : 'italic',
                        }}>
                          {q.prompt || 'No prompt set'}
                        </span>

                        {/* Eye icon — stopPropagation so it doesn't toggle expand */}
                        <button
                          onClick={e => { e.stopPropagation(); handlePrepToggleHidden(idx) }}
                          disabled={prepDisabled}
                          title={q.hidden ? 'Show to students' : 'Hide from students'}
                          style={{
                            display: 'flex', alignItems: 'center',
                            background: 'none', border: 'none', padding: '0.2rem',
                            cursor: prepDisabled ? 'not-allowed' : 'pointer',
                            color: q.hidden ? '#94a3b8' : '#475569',
                            flexShrink: 0,
                          }}
                        >
                          <EyeIcon slashed={q.hidden} />
                        </button>

                        {/* Expand indicator */}
                        <span style={{ color: '#cbd5e1', fontSize: '0.7rem', flexShrink: 0 }}>
                          {isExpanded ? '▲' : '▼'}
                        </span>
                      </div>

                      {/* ── Expanded editor ── */}
                      {isExpanded && (
                        <div style={{
                          padding: '0.875rem 1rem 1rem',
                          background: q.system ? '#f8faff' : '#fafafa',
                          borderBottom: '1px solid #e2e8f0',
                        }}>
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

                          {/* Placeholder — text and number questions only */}
                          {q.type !== 'mc' && (
                            <>
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
                            </>
                          )}

                          {/* MC options — with correct-answer selector for KC, assigned-role note, or plain labels */}
                          {q.type === 'mc' && q.options !== undefined && (
                            <div style={{ marginTop: '0.625rem' }}>
                              {q.grading === 'assigned_role' ? (
                                <>
                                  <div style={{
                                    fontSize: '0.8rem', color: '#1d4ed8', background: '#eff6ff',
                                    border: '1px solid #bfdbfe', borderRadius: 4,
                                    padding: '0.4rem 0.625rem', marginBottom: '0.5rem',
                                  }}>
                                    Graded against each student's assigned role.
                                  </div>
                                  <label style={{ ...fieldLabel, marginBottom: '0.375rem' }}>
                                    Option labels <span style={{ fontWeight: 400, color: '#9ca3af' }}>(value is locked; only the display label is editable)</span>
                                  </label>
                                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.375rem' }}>
                                    {q.options.map((opt, optIdx) => (
                                      <div key={opt.value || optIdx} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                                        <span style={{
                                          fontSize: '0.75rem', fontFamily: 'monospace', color: '#64748b',
                                          background: '#f1f5f9', padding: '0.25rem 0.5rem', borderRadius: 3,
                                          minWidth: '3.5rem', textAlign: 'center', flexShrink: 0,
                                        }}>{opt.value}</span>
                                        <input
                                          type="text"
                                          value={opt.label}
                                          onChange={e => handlePrepOptionLabel(idx, optIdx, e.target.value)}
                                          disabled={prepDisabled}
                                          style={{ ...inputStyle, fontSize: '0.875rem', padding: '0.35rem 0.625rem' }}
                                        />
                                      </div>
                                    ))}
                                  </div>
                                </>
                              ) : q.grading === 'static' ? (
                                <>
                                  <label style={{ ...fieldLabel, marginBottom: '0.375rem' }}>
                                    Correct answer{' '}
                                    <span style={{ fontWeight: 400, color: '#9ca3af' }}>
                                      (select the correct option; value is locked once set, only the label is editable)
                                    </span>
                                  </label>
                                  {q.options.length === 0 && (
                                    <p style={{ fontSize: '0.8rem', color: '#94a3b8', margin: '0 0 0.5rem', fontStyle: 'italic' }}>
                                      No options yet — add options below, then select the correct answer.
                                    </p>
                                  )}
                                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.375rem' }}>
                                    {q.options.map((opt, optIdx) => {
                                      const preview = slugify(opt.label) || `opt_${optIdx + 1}`
                                      return (
                                        <div key={opt.value || `_new_${optIdx}`} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                                          {/* Correct-answer radio */}
                                          <input
                                            type="radio"
                                            name={`kc_correct_${q.field}`}
                                            checked={!!opt.value && q.correct_value === opt.value}
                                            onChange={() => { if (opt.value) handlePrepCorrectValue(idx, opt.value) }}
                                            disabled={prepDisabled || !opt.value}
                                            title={opt.value ? 'Mark as correct answer' : 'Save an option label first to select it'}
                                            style={{ flexShrink: 0, cursor: opt.value && !prepDisabled ? 'pointer' : 'default' }}
                                          />
                                          {/* Value chip: locked or preview */}
                                          <span style={{
                                            fontSize: '0.75rem', fontFamily: 'monospace',
                                            color: opt.value ? '#64748b' : '#94a3b8',
                                            background: opt.value ? '#f1f5f9' : '#fafafa',
                                            border: opt.value ? '1px solid transparent' : '1px dashed #cbd5e1',
                                            padding: '0.25rem 0.5rem', borderRadius: 3,
                                            minWidth: '3.5rem', textAlign: 'center', flexShrink: 0,
                                            fontStyle: opt.value ? 'normal' : 'italic',
                                          }}>{opt.value || preview}</span>
                                          {/* Label input */}
                                          <input
                                            type="text"
                                            value={opt.label}
                                            onChange={e => handlePrepOptionLabel(idx, optIdx, e.target.value)}
                                            onBlur={() => { if (!opt.value) handlePrepOptionBlur(idx, optIdx) }}
                                            disabled={prepDisabled}
                                            placeholder="Option label…"
                                            style={{ ...inputStyle, fontSize: '0.875rem', padding: '0.35rem 0.625rem' }}
                                          />
                                        </div>
                                      )
                                    })}
                                  </div>
                                  {!q.system && (
                                    <button
                                      onClick={() => handlePrepAddOption(idx)}
                                      disabled={prepDisabled}
                                      style={{
                                        marginTop: '0.375rem', alignSelf: 'flex-start',
                                        fontSize: '0.78rem', padding: '0.25rem 0.625rem',
                                        background: 'none', border: '1px solid #cbd5e1', borderRadius: 3,
                                        color: '#64748b', cursor: prepDisabled ? 'not-allowed' : 'pointer',
                                      }}
                                    >
                                      + Add option
                                    </button>
                                  )}
                                  {q.category === 'knowledge_check' && (
                                    <div style={{ marginTop: '0.75rem' }}>
                                      <label style={{ ...fieldLabel, marginBottom: '0.25rem' }}>
                                        Explanation{' '}
                                        <span style={{ fontWeight: 400, color: '#9ca3af' }}>
                                          (shown to student after they submit this question)
                                        </span>
                                      </label>
                                      <textarea
                                        value={q.explanation ?? ''}
                                        onChange={e => handlePrepEdit(idx, { explanation: e.target.value || undefined })}
                                        disabled={prepDisabled}
                                        rows={2}
                                        placeholder="e.g. Correct: A. Because…"
                                        style={{
                                          ...inputStyle,
                                          fontSize: '0.875rem', padding: '0.35rem 0.625rem',
                                          resize: 'vertical', fontFamily: 'inherit',
                                        }}
                                      />
                                    </div>
                                  )}
                                </>
                              ) : (
                                <>
                                  <label style={{ ...fieldLabel, marginBottom: '0.375rem' }}>
                                    Option labels <span style={{ fontWeight: 400, color: '#9ca3af' }}>(value is locked; only the display label is editable)</span>
                                  </label>
                                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.375rem' }}>
                                    {q.options.map((opt, optIdx) => (
                                      <div key={opt.value || optIdx} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                                        <span style={{
                                          fontSize: '0.75rem', fontFamily: 'monospace', color: '#64748b',
                                          background: '#f1f5f9', padding: '0.25rem 0.5rem', borderRadius: 3,
                                          minWidth: '3.5rem', textAlign: 'center', flexShrink: 0,
                                        }}>{opt.value}</span>
                                        <input
                                          type="text"
                                          value={opt.label}
                                          onChange={e => handlePrepOptionLabel(idx, optIdx, e.target.value)}
                                          disabled={prepDisabled}
                                          style={{ ...inputStyle, fontSize: '0.875rem', padding: '0.35rem 0.625rem' }}
                                        />
                                      </div>
                                    ))}
                                  </div>
                                </>
                              )}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>

              {/* Add question + Save row */}
              <div style={{ padding: '0.875rem 1rem', borderTop: '1px solid #f1f5f9' }}>
                <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                  <button
                    onClick={handlePrepAddQuestion}
                    disabled={prepDisabled}
                    style={{
                      fontSize: '0.875rem', padding: '0.4rem 0.875rem',
                      background: 'none', border: '1px solid #94a3b8', borderRadius: 5, color: '#475569',
                      cursor: prepDisabled ? 'not-allowed' : 'pointer',
                    }}
                  >
                    + Add prep question
                  </button>
                  <button
                    onClick={handlePrepAddKCQuestion}
                    disabled={prepDisabled}
                    style={{
                      fontSize: '0.875rem', padding: '0.4rem 0.875rem',
                      background: 'none', border: '1px solid #d97706', borderRadius: 5, color: '#92400e',
                      cursor: prepDisabled ? 'not-allowed' : 'pointer',
                    }}
                  >
                    + Add knowledge-check question
                  </button>
                </div>

                <div style={saveRowStyle}>
                  <button onClick={handlePrepSave} disabled={prepDisabled} style={saveBtn(prepSaving, prepDisabled)}>
                    {prepSaving ? 'Saving…' : 'Save'}
                  </button>
                  {prepSavedAt != null && !prepSaving && <span style={{ fontSize: '0.8rem', color: '#16a34a' }}>Saved {prepSavedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>}
                  {prepSaveError && <span style={{ fontSize: '0.8rem', color: '#dc2626' }}>{prepSaveError}</span>}
                </div>
              </div>
            </div>
          )}
        </div>

      </main>
    </div>
  )
}
