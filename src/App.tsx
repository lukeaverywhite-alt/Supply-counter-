import { useEffect, useMemo, useState } from 'react'
import {
  Activity, Archive, ArrowRight, Boxes, ChevronDown, ClipboardCheck, Cloud, History,
  LayoutGrid, Minus, PackagePlus, Plus, RotateCcw, Search, Settings, ShieldCheck,
  UserRound, Users, Wifi, LogOut, FileUp, CalendarRange, KeyRound, X, Check, Shirt,
} from 'lucide-react'
import { loadData, matchesSearch, rollover, saveData, statusFor, submitCount, transact, withAudit } from './domain'
import type { AppData, InventoryItem } from './types'

type Tab = 'count' | 'inventory' | 'cadets' | 'activity' | 'more'
type Panel = 'signin' | 'cadet' | 'issue' | 'return' | 'review' | 'bundles' | 'needed' | 'roster' | 'rollover' | 'import' | 'roles' | null

const navItems: { id: Tab; label: string; icon: typeof Activity }[] = [
  { id: 'count', label: 'Count', icon: ClipboardCheck },
  { id: 'inventory', label: 'Inventory', icon: Boxes },
  { id: 'cadets', label: 'Cadets', icon: Users },
  { id: 'activity', label: 'Activity', icon: History },
  { id: 'more', label: 'More', icon: LayoutGrid },
]

function App() {
  const [tab, setTab] = useState<Tab>('count')
  const [data, setData] = useState<AppData>(() => loadData())
  const items = data.inventory
  const [selectedId, setSelectedId] = useState(items[0].id)
  const [count, setCount] = useState(data.session.counts[items[0].id] ?? items[0].onHand)
  const [step, setStep] = useState(items[0].countBy)
  const [query, setQuery] = useState('')
  const [showAdd, setShowAdd] = useState(false)
  const [panel, setPanel] = useState<Panel>(null)
  const [cadetQuery, setCadetQuery] = useState('')
  const [notice, setNotice] = useState('')
  const [countHistory, setCountHistory] = useState<{ itemId: string; itemName: string; from: number; to: number }[]>([])
  const selected = items.find((item) => item.id === selectedId) ?? items[0]
  const filtered = useMemo(() => {
    return items.filter((item) => matchesSearch(query, item.name, item.category, item.size, item.niin))
  }, [items, query])

  useEffect(() => saveData(data), [data])
  useEffect(() => {
    if (!notice) return
    const timeout = window.setTimeout(() => setNotice(''), 4000)
    return () => window.clearTimeout(timeout)
  }, [notice])

  const updateCount = (value: number, remember = true) => {
    const safeValue = Math.max(0, value)
    if (safeValue === count) return
    if (remember) setCountHistory(current => [...current, { itemId: selected.id, itemName: `${selected.name} · ${selected.size}`, from: count, to: safeValue }])
    setCount(safeValue)
    setData(current => ({ ...current, session: { ...current.session, status: 'draft', submittedAt: undefined, counts: { ...current.session.counts, [selected.id]: safeValue } } }))
  }

  const undoCount = () => {
    const last = countHistory.at(-1)
    if (!last) return
    const item = items.find(entry => entry.id === last.itemId)
    if (!item) return
    setSelectedId(item.id)
    setCount(last.from)
    setStep(item.countBy)
    setData(current => ({ ...current, session: { ...current.session, counts: { ...current.session.counts, [item.id]: last.from } } }))
    setCountHistory(current => current.slice(0, -1))
    setNotice(`Undid ${last.itemName}: ${last.to} → ${last.from}.`)
  }

  const selectItem = (item: InventoryItem) => {
    setSelectedId(item.id)
    setCount(data.session.counts[item.id] ?? item.onHand)
    setStep(item.countBy)
    setQuery('')
  }

  const runAction = (action: (current: AppData) => AppData, success: string) => {
    try {
      setData(action(data))
      setNotice(success)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'The action could not be completed.')
    }
  }

  return (
    <div className="app-shell">
      <div className="aether-field" aria-hidden="true"><span /><span /><span /></div>
      <aside className="sidebar">
        <Brand />
        <nav aria-label="Primary navigation">
          {navItems.map(({ id, label, icon: Icon }) => (
            <button className={tab === id ? 'nav-item active' : 'nav-item'} key={id} onClick={() => setTab(id)}>
              <Icon size={19} /> <span>{label}</span>{id === 'count' && <span className="nav-dot" />}
            </button>
          ))}
        </nav>
        <div className="system-card">
          <span className="pulse" /><strong>Prototype mode</strong>
          <p>Local preview only</p>
        </div>
        <button className="profile" onClick={() => setPanel('signin')}>
          <span className="avatar">RW</span><span><strong>Riley West</strong><small>Supply Staff</small></span><ChevronDown size={16} />
        </button>
      </aside>

      <main className="main-stage">
        <header className="topbar">
          <div><p className="eyebrow">BETHEL NJROTC SUPPLY</p><h1>{pageTitle(tab)}</h1></div>
          <div className="top-actions"><span className="sync"><Wifi size={15} /> Local draft</span><button className="icon-button" aria-label="Settings"><Settings size={20} /></button><span className="top-avatar">RW</span></div>
        </header>

        {notice && <div className="app-notice" role="status">{notice}</div>}
        {tab === 'count' && <CountView session={data.session} selected={selected} count={count} setCount={updateCount} step={step} setStep={setStep} query={query} setQuery={setQuery} filtered={filtered} selectItem={selectItem} onReview={() => setPanel('review')} lastAction={countHistory.at(-1)} onUndo={undoCount} />}
        {tab === 'inventory' && <InventoryView items={filtered} query={query} setQuery={setQuery} onAdd={() => setShowAdd(true)} selectItem={(item) => { selectItem(item); setTab('count') }} />}
        {tab === 'cadets' && <CadetsView cadets={data.cadets} query={cadetQuery} setQuery={setCadetQuery} onOpen={() => setPanel('cadet')} />}
        {tab === 'activity' && <ActivityView data={data} />}
        {tab === 'more' && <MoreView onOpen={setPanel} />}
      </main>

      <nav className="mobile-nav" aria-label="Mobile navigation">
        {navItems.map(({ id, label, icon: Icon }) => <button className={tab === id ? 'active' : ''} key={id} onClick={() => setTab(id)}><Icon size={21} /><span>{label}</span></button>)}
      </nav>

      {showAdd && <AddItemModal inventory={items} onClose={() => setShowAdd(false)} onSave={(item) => { const created = { ...item, id: crypto.randomUUID(), issued: 0, status: statusFor(item) }; setData(current => withAudit({ ...current, inventory: [...current.inventory, created] }, 'item.created', `Created ${created.name}`, created.id)); setShowAdd(false); setNotice(`${created.name} was added.`) }} />}
      {panel && <DemoPanel data={data} panel={panel} count={count} official={selected.onHand} onClose={() => setPanel(null)} onOpen={setPanel} onSubmitCount={() => { runAction(current => submitCount(current), 'Physical count submitted.'); setPanel(null) }} onIssue={() => { runAction(current => transact(current, selected.id, 1, 'issue', 'cadet-am'), `Issued 1 ${selected.name}.`); setPanel(null) }} onReturn={() => { runAction(current => transact(current, selected.id, 1, 'return', 'cadet-am'), `Returned 1 ${selected.name}.`); setPanel(null) }} onRollover={() => { runAction(current => rollover(current, true), 'Annual rollover completed.'); setPanel(null) }} />}
    </div>
  )
}

function Brand() {
  return <div className="brand"><img src={`${import.meta.env.BASE_URL}argus-mark.svg`} alt="" /><div><strong>A.R.G.U.S.</strong><span>ASSET READINESS SYSTEM</span></div></div>
}

function pageTitle(tab: Tab) {
  return { count: 'Physical Count', inventory: 'Inventory', cadets: 'Cadets', activity: 'Activity', more: 'Command Center' }[tab]
}

function sessionLabel(status: AppData['session']['status']) {
  return ({ draft: 'Draft', active: 'Active', submitted: 'Submitted', 'needs-approval': 'Needs Approval', reconciled: 'Reconciled', cancelled: 'Cancelled' })[status]
}

type CountProps = {
  session: AppData['session'];
  selected: InventoryItem; count: number; setCount: (value: number) => void; step: number; setStep: (value: number) => void
  query: string; setQuery: (value: string) => void; filtered: InventoryItem[]; selectItem: (item: InventoryItem) => void
  onReview: () => void
  lastAction?: { itemName: string; from: number; to: number }; onUndo: () => void
}

function CountView({ session, selected, count, setCount, step, setStep, query, setQuery, filtered, selectItem, onReview, lastAction, onUndo }: CountProps) {
  const difference = count - selected.onHand
  const chooseCustomStep = () => {
    const response = window.prompt('Enter a count increment greater than zero', String(step))
    if (response === null) return
    const nextStep = Number.parseInt(response, 10)
    if (Number.isInteger(nextStep) && nextStep > 0) setStep(nextStep)
  }
  return <div className="content count-page">
    <section className="hero-row">
      <div><div className="section-kicker"><span /><b>ACTIVE SESSION</b><span /></div><h2>Count with confidence.</h2><p>Every tap is saved to this draft. Official inventory changes only after review.</p></div>
      <div className="session-chip"><span className="pulse" /><div><small>{sessionLabel(session.status).toUpperCase()}</small><strong>{session.name}</strong></div><ChevronDown size={16} /></div>
    </section>

    <div className="search-wrap">
      <Search size={20} /><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search item name or CDMIS NIIN…" aria-label="Search inventory" /><kbd>⌘ K</kbd>
      {query && <div className="search-results">{filtered.length ? filtered.map((item) => <button key={item.id} onClick={() => selectItem(item)}><span><strong>{item.name}</strong><small>{item.category} · {item.niin}</small></span><b>{item.size}</b></button>) : <p>No inventory matches that search.</p>}</div>}
    </div>

    <div className="count-layout">
      <section className="count-card marble-card">
        <div className="item-heading"><div className="item-icon"><Boxes /></div><div><span>{selected.category.toUpperCase()}</span><h3>{selected.name}</h3><p>Size: <strong>{selected.size}</strong> · {selected.niin}</p></div><button className="text-button">Change item</button></div>
        <div className="count-display"><small>YOUR PHYSICAL COUNT</small><strong>{count}</strong><span>UNITS COUNTED</span></div>
        <div className="step-label"><span>COUNT BY</span><div>{[1, 5, 10].map((value) => <button key={value} onClick={() => setStep(value)} className={step === value ? 'active' : ''}>{value}</button>)}<button className={![1,5,10].includes(step) ? 'active' : ''} onClick={chooseCustomStep}>{![1,5,10].includes(step) ? step : 'Custom'}</button></div></div>
        <div className="counter-actions">
          <button className="stone-button minus" onClick={() => setCount(Math.max(0, count - step))}><Minus /><span>Subtract {step}</span></button>
          <button className="stone-button plus" onClick={() => setCount(count + step)}><Plus /><span>Add {step}</span></button>
        </div>
        <button className="undo-button" disabled={!lastAction} onClick={onUndo}><RotateCcw size={16} /> {lastAction ? `Undo ${lastAction.itemName}: ${lastAction.to} → ${lastAction.from}` : 'Nothing to undo'}</button>
      </section>

      <aside className="review-card">
        <div className="card-title"><span><ClipboardCheck size={18} /></span><div><small>LIVE COMPARISON</small><h3>Count review</h3></div></div>
        <div className="stat-row"><span>Official on hand<small>Before this count</small></span><strong>{selected.onHand}</strong></div>
        <div className="stat-row"><span>Physical count<small>Combined session</small></span><strong>{count}</strong></div>
        <div className={difference === 0 ? 'difference match' : 'difference warning'}><span>{difference === 0 ? <ShieldCheck /> : <Activity />}</span><div><small>DIFFERENCE</small><strong>{difference > 0 ? '+' : ''}{difference} units</strong><p>{difference === 0 ? 'Inventory matches the record.' : 'Administrator review required.'}</p></div></div>
        <div className="contributors"><div className="contributor-avatars"><span>RW</span><span>KM</span><span>+1</span></div><p><strong>3 staff counting</strong><br/>Updated just now</p><Cloud size={18} /></div>
        <button className="primary-button" onClick={onReview}>Review & submit <ArrowRight size={18} /></button>
        <p className="safe-note"><ShieldCheck size={14} /> Draft only—official inventory is unchanged</p>
      </aside>
    </div>
  </div>
}

function InventoryView({ items, query, setQuery, onAdd, selectItem }: { items: InventoryItem[]; query: string; setQuery: (v: string) => void; onAdd: () => void; selectItem: (i: InventoryItem) => void }) {
  const totalOnHand = items.reduce((total, item) => total + item.onHand, 0)
  const totalIssued = items.reduce((total, item) => total + item.issued, 0)
  const attentionCount = items.filter((item) => item.status !== 'Healthy').length
  return <div className="content"><section className="page-intro"><div><p className="eyebrow">SERVICEABLE INVENTORY</p><h2>Every asset, accounted for.</h2><p>Search by item, size, category, or CDMIS NIIN.</p></div><button className="gold-button" onClick={onAdd}><PackagePlus size={18} /> Add item</button></section>
    <div className="summary-grid"><Summary label="On hand" value={String(totalOnHand)} detail={`${items.length} tracked variant${items.length === 1 ? '' : 's'}`} /><Summary label="Issued" value={String(totalIssued)} detail="Across active cadets" /><Summary label="Needs attention" value={String(attentionCount)} detail="Low stock or count due" accent /></div>
    <div className="table-card"><div className="table-tools"><div className="inline-search"><Search size={18}/><input aria-label="Search inventory table" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search inventory…" /></div><button><Settings size={17}/> Filters</button></div>
      <div className="inventory-list">{items.map((item) => <button className="inventory-row" key={item.id} onClick={() => selectItem(item)}><span className="category-mark">{item.name.slice(0,2).toUpperCase()}</span><span className="item-name"><strong>{item.name}</strong><small>{item.category} · {item.niin}</small></span><span><small>SIZE</small><b>{item.size}</b></span><span><small>ON HAND</small><b>{item.onHand}</b></span><span><small>ISSUED</small><b>{item.issued}</b></span><em className={item.status === 'Healthy' ? 'ready' : 'attention'}>{item.status}</em><ArrowRight size={18}/></button>)}</div>
    </div>
  </div>
}

function Summary({ label, value, detail, accent = false }: { label: string; value: string; detail: string; accent?: boolean }) {
  return <div className={accent ? 'summary-card accent' : 'summary-card'}><small>{label.toUpperCase()}</small><strong>{value}</strong><p>{detail}</p></div>
}

function CadetsView({ cadets, query, setQuery, onOpen }: { cadets: AppData['cadets']; query: string; setQuery: (value: string) => void; onOpen: () => void }) {
  const visible = cadets.filter(cadet => matchesSearch(query, cadet.name, cadet.name.split(' ').reverse().join(' '), cadet.level, cadet.configuration))
  return <div className="content"><section className="page-intro"><div><p className="eyebrow">PERSONNEL ACCOUNTABILITY</p><h2>Cadet property records.</h2><p>Fictional records are shown in this front-end preview.</p></div><button className="gold-button"><UserRound size={18}/> Add cadet</button></section><div className="table-card"><div className="table-tools"><div className="inline-search"><Search size={18}/><input aria-label="Search cadets" value={query} onChange={event => setQuery(event.target.value)} placeholder="Search cadet name…" /></div></div><div className="cadet-grid">{visible.map(cadet => <button className="cadet-card" key={cadet.id} onClick={onOpen}><span className="large-avatar">{cadet.initials}</span><span><strong>{cadet.name}</strong><small>{cadet.level} · {cadet.configuration}</small></span><div><b>{cadet.items}</b><small>Issued items</small></div><em className={cadet.status === 'Clear' ? 'ready' : 'attention'}>{cadet.status}</em><ArrowRight size={18}/></button>)}</div></div></div>
}

function ActivityView({ data }: { data: AppData }) {
  return <div className="content"><section className="page-intro"><div><p className="eyebrow">AUDIT TRAIL</p><h2>Nothing changes silently.</h2><p>A local, append-only record of actions and outcomes.</p></div></section><div className="timeline">{data.audit.length ? data.audit.map(event => <div className="event" key={event.id}><span className="event-icon"><History/></span><div><strong>{event.summary}</strong><p>{event.type}</p></div><span className="event-user">{event.actor.split(' ').map(v => v[0]).join('')}</span><time>{new Date(event.at).toLocaleString()}</time></div>) : <div className="empty-state">No activity yet. Completed actions will appear here.</div>}</div></div>
}

function MoreView({ onOpen }: { onOpen: (panel: Panel) => void }) {
  const options: { icon: typeof Activity; title: string; desc: string; panel: Panel }[] = [{ icon: PackagePlus, title: 'Issue bundles', desc: 'Build and manage standard uniform sets', panel: 'bundles' },{ icon: Archive, title: 'Still needed', desc: 'Track incomplete cadet issues', panel: 'needed' },{ icon: Users, title: 'Roster administration', desc: 'Import, edit, and prepare annual rollover', panel: 'roster' },{ icon: ShieldCheck, title: 'Roles & access', desc: 'Manage authorized supply staff', panel: 'roles' },{ icon: FileUp, title: 'Import preview', desc: 'Validate a fictional roster before upload', panel: 'import' },{ icon: CalendarRange, title: 'Annual rollover', desc: 'Preview promotions and archived records', panel: 'rollover' }]
  return <div className="content"><section className="page-intro"><div><p className="eyebrow">ADMINISTRATION</p><h2>Command center.</h2><p>Protected tools for keeping A.R.G.U.S. ready.</p></div></section><div className="command-grid">{options.map(({icon:Icon,title,desc,panel}) => <button key={title} onClick={() => onOpen(panel)}><span><Icon/></span><div><strong>{title}</strong><p>{desc}</p></div><ArrowRight/></button>)}</div></div>
}

function DemoPanel({ data, panel, count, official, onClose, onOpen, onSubmitCount, onIssue, onReturn, onRollover }: { data: AppData; panel: Exclude<Panel, null>; count: number; official: number; onClose: () => void; onOpen: (panel: Panel) => void; onSubmitCount: () => void; onIssue: () => void; onReturn: () => void; onRollover: () => void }) {
  const difference = count - official
  const screens = {
    signin: { kicker: 'SECURE DEMONSTRATION', title: 'Welcome back', icon: KeyRound },
    cadet: { kicker: 'PROPERTY RECORD · FICTIONAL', title: 'Alex Morgan', icon: UserRound },
    issue: { kicker: 'ISSUE TRANSACTION', title: 'Issue selected items', icon: PackagePlus },
    return: { kicker: 'RETURN TRANSACTION', title: 'Record a return', icon: RotateCcw },
    review: { kicker: 'SESSION #024', title: 'Review physical count', icon: ClipboardCheck },
    bundles: { kicker: 'STANDARD CONFIGURATIONS', title: 'Bundle selection', icon: Shirt },
    needed: { kicker: 'OPEN REQUIREMENTS', title: 'Still Needed', icon: Archive },
    roster: { kicker: 'ROSTER ADMINISTRATION', title: 'Cadet roster', icon: Users },
    rollover: { kicker: '2026 → 2027', title: 'Annual rollover preview', icon: CalendarRange },
    import: { kicker: 'VALIDATION PREVIEW', title: 'Import 24 cadets', icon: FileUp },
    roles: { kicker: 'AUTHORIZED USERS', title: 'Roles & access', icon: ShieldCheck },
  }[panel]
  const Icon = screens.icon
  return <div className="drawer-backdrop" role="presentation" onMouseDown={onClose}><aside className="demo-drawer" role="dialog" aria-modal="true" aria-labelledby="drawer-title" onMouseDown={event => event.stopPropagation()}>
    <header><span className="drawer-icon"><Icon /></span><div><p className="eyebrow">{screens.kicker}</p><h2 id="drawer-title">{screens.title}</h2></div><button aria-label="Close panel" onClick={onClose}><X /></button></header>
    {panel === 'signin' && <><div className="signin-crest"><Brand /><p>Use a fictional prototype identity to continue.</p></div><label className="field">Email<input defaultValue="riley.west@demo.invalid" /></label><label className="field">Password<input type="password" defaultValue="prototype" /></label><button className="primary-button">Sign in to A.R.G.U.S. <ArrowRight size={17}/></button><button className="quiet-action"><LogOut size={15}/> Sign out of preview</button></>}
    {panel === 'cadet' && <><div className="record-hero"><span className="large-avatar">AM</span><div><strong>Alex Morgan</strong><p>NS1 · Alpha Company · Standard A</p></div><em className="attention">1 still needed</em></div><div className="record-stats"><Summary label="Issued" value="6" detail="Active property"/><Summary label="Due" value="1" detail="Missing size"/></div><PanelRows rows={['Navy PT Shirt · Medium|2 issued Aug 18','Navy PT Shorts · Medium|2 issued Aug 18','White Undershirt · Large|2 issued Aug 18','Black Oxford Shoes · 10 Regular|Still needed']} /><div className="split-actions"><button onClick={() => onOpen('return')}>Return item</button><button className="primary-button" onClick={() => onOpen('issue')}>Issue items</button></div></>}
    {panel === 'issue' && <><Notice text="Issuing one selected inventory item to Alex Morgan · NS1"/><PanelRows selectable rows={['Navy PT Shirt · Medium|24 available','Navy PT Shorts · Medium|8 available','Black Oxford Shoes · 10 R|6 available']} /><label className="field">Condition<select><option>Serviceable / new</option><option>Serviceable / used</option></select></label><button className="primary-button" onClick={onIssue}>Confirm issue <ArrowRight size={17}/></button></>}
    {panel === 'return' && <><Notice text="Returning one selected inventory item from Alex Morgan"/><PanelRows selectable rows={['Navy PT Shirt · Medium|Issued Aug 18','Navy PT Shorts · Medium|Issued Aug 18']} /><label className="field">Return condition<select><option>Serviceable</option><option>Laundry / inspection</option><option>Unserviceable</option></select></label><button className="primary-button" onClick={onReturn}>Record return <RotateCcw size={17}/></button></>}
    {panel === 'review' && <><Notice text="Submitting updates official inventory and creates an audit record"/><div className="review-hero"><div><small>OFFICIAL</small><strong>{official}</strong></div><ArrowRight/><div><small>PHYSICAL</small><strong>{count}</strong></div></div><div className={difference === 0 ? 'difference match' : 'difference warning'}><Activity/><div><small>DISCREPANCY</small><strong>{difference > 0 ? '+' : ''}{difference} units</strong><p>{difference === 0 ? 'No adjustment required.' : 'The adjustment will be recorded.'}</p></div></div><label className="field">Review note<textarea placeholder="Optional context for the audit record" /></label><button className="primary-button" onClick={onSubmitCount}>Submit count <ShieldCheck size={17}/></button></>}
    {panel === 'bundles' && <><Notice text="Select a standard configuration, then confirm sizes."/><PanelRows selectable rows={['Standard A · NS1|8 required pieces','PT Gear starter|3 required pieces','Drill team add-on|4 optional pieces']} /><button className="primary-button">Continue to sizes <ArrowRight size={17}/></button></>}
    {panel === 'needed' && <><Notice text={`${data.stillNeeded.length} open requirement${data.stillNeeded.length === 1 ? '' : 's'} · availability updates with inventory`}/><div className="needed-list">{data.stillNeeded.map(need => { const cadet = data.cadets.find(entry => entry.id === need.cadetId); const item = data.inventory.find(entry => entry.id === need.itemId); const available = (item?.onHand ?? 0) >= need.quantity; return <div className="needed-row" key={need.id}><div><strong>{cadet?.name ?? 'Unknown cadet'}</strong><small>{item?.name ?? 'Unknown item'} · Size {need.requiredSize}</small></div><b>{need.quantity}</b><time>{new Date(need.firstNeededAt).toLocaleDateString()}</time><em className={available ? 'ready' : 'attention'}>{available ? 'Now available' : 'Awaiting stock'}</em></div> })}</div></>}
    {panel === 'roster' && <><div className="drawer-toolbar"><button onClick={() => onOpen('import')}><FileUp/> Import roster</button><button onClick={() => onOpen('rollover')}><CalendarRange/> Preview rollover</button></div><PanelRows rows={['Alex Morgan|NS1 · Alpha','Jordan Carter|NS3 · Bravo','Taylor Sample|NS4 · Staff']} /></>}
    {panel === 'rollover' && <><div className="review-hero"><div><small>PROMOTE</small><strong>2</strong></div><div><small>ARCHIVE</small><strong>1</strong></div><div><small>REVIEW</small><strong>1</strong></div></div><PanelRows rows={['Alex Morgan · NS1 → NS2|Ready','Jordan Carter · NS3 → NS4|Ready','Taylor Sample · NS4|Archive after returns · Review']} /><button className="primary-button" onClick={onRollover}>Complete rollover</button></>}
    {panel === 'import' && <><Notice text="cadet_roster_demo.csv · No data has been saved"/><div className="validation"><Check/><div><strong>22 rows ready</strong><p>2 rows need review before import</p></div></div><PanelRows rows={['Row 8 · Duplicate student ID|Needs review','Row 19 · Missing company|Needs review']} /><button className="primary-button">Import 22 valid records</button></>}
    {panel === 'roles' && <><PanelRows rows={['Riley West|Supply Staff · Active','Kendall Moore|Supply Staff · Active','Avery Demo|Supply Officer · Active']} /><div className="role-key"><strong>Role permissions</strong><p><b>Supply Staff</b> can count, issue, and return. <b>Supply Officer</b> can approve adjustments and administer users.</p></div><button className="primary-button">Invite authorized user</button></>}
  </aside></div>
}

function Notice({ text }: { text: string }) { return <div className="notice"><ShieldCheck size={17}/><span>{text}</span></div> }
function PanelRows({ rows, selectable = false }: { rows: string[]; selectable?: boolean }) { return <div className="panel-rows">{rows.map((row, index) => { const [title, detail] = row.split('|'); return <label key={title}>{selectable && <input type="checkbox" defaultChecked={index < 2}/>}<span><strong>{title}</strong><small>{detail}</small></span>{!selectable && <ArrowRight size={16}/>}</label> })}</div> }

function AddItemModal({ inventory, onClose, onSave }: { inventory: InventoryItem[]; onClose: () => void; onSave: (item: Omit<InventoryItem, 'id' | 'issued' | 'status'>) => void }) {
  const [name, setName] = useState(''); const [category, setCategory] = useState(''); const [size, setSize] = useState(''); const [niin, setNiin] = useState(''); const [qty, setQty] = useState(0); const [useThreshold, setUseThreshold] = useState(false); const [threshold, setThreshold] = useState(0)
  const duplicates = inventory.filter(item => (name.trim().length >= 3 && matchesSearch(name, item.name)) || (niin.trim() && matchesSearch(niin, item.niin)))
  return <div className="modal-backdrop" role="presentation" onMouseDown={onClose}><form className="modal" onSubmit={(e) => { e.preventDefault(); const resolvedSize = size || 'No size'; onSave({ name, category, sizes: resolvedSize.split(',').map(value => value.trim()).filter(Boolean), size: resolvedSize.split(',')[0].trim(), niin: niin || 'Not assigned', onHand: qty, reorderAt: useThreshold ? threshold : undefined, countBy: 1 }) }} onMouseDown={(e) => e.stopPropagation()}><div className="modal-heading"><div><p className="eyebrow">INVENTORY ADMINISTRATION</p><h2>Add a new item</h2></div><button type="button" onClick={onClose}>×</button></div><p>Create the core item now. Warning levels are optional.</p><label>Item name<input required value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Navy PT Shirt" /></label>{duplicates.length > 0 && <div className="duplicate-warning" role="alert"><strong>Possible duplicate</strong><span>{duplicates.map(item => `${item.name} · ${item.size} · ${item.niin}`).join(', ')}</span></div>}<div className="form-grid"><label>Category<input required value={category} onChange={e => setCategory(e.target.value)} placeholder="PT Gear" /></label><label>Size or variant<input value={size} onChange={e => setSize(e.target.value)} placeholder="Medium" /></label><label>CDMIS NIIN<input value={niin} onChange={e => setNiin(e.target.value)} placeholder="Optional" /></label><label>Initial on hand<input type="number" min="0" value={qty} onChange={e => setQty(Number(e.target.value))} /></label></div><label className="threshold-toggle"><input type="checkbox" checked={useThreshold} onChange={e => setUseThreshold(e.target.checked)}/> Enable low-stock warning</label>{useThreshold && <label>Warn when on hand is at or below<input aria-label="Low-stock threshold" type="number" min="0" value={threshold} onChange={e => setThreshold(Number(e.target.value))}/></label>}<div className="modal-actions"><button type="button" onClick={onClose}>Cancel</button><button className="primary-button" type="submit">Add item <ArrowRight size={17}/></button></div></form></div>
}

export default App
