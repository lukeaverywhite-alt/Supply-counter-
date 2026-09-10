import { useEffect, useMemo, useState } from 'react'
import {
  Activity, Archive, ArrowRight, Boxes, ChevronDown, ClipboardCheck, Cloud, History,
  LayoutGrid, Minus, PackagePlus, Plus, RotateCcw, Search, Settings, ShieldCheck,
  Users, Wifi,
} from 'lucide-react'
import { loadData, rollover, saveData, submitCount, transact, withAudit } from './domain'
import type { AppData, InventoryItem } from './types'

type Tab = 'count' | 'inventory' | 'cadets' | 'activity' | 'more'

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
  const [notice, setNotice] = useState('')
  const selected = items.find((item) => item.id === selectedId) ?? items[0]
  const filtered = useMemo(() => {
    const value = query.toLowerCase().replaceAll('-', '').replaceAll(' ', '')
    return items.filter((item) => `${item.name}${item.category}${item.size}${item.niin}`.toLowerCase().replaceAll('-', '').replaceAll(' ', '').includes(value))
  }, [items, query])

  useEffect(() => saveData(data), [data])

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
        <button className="profile">
          <span className="avatar">RW</span><span><strong>Riley West</strong><small>Supply Staff</small></span><ChevronDown size={16} />
        </button>
      </aside>

      <main className="main-stage">
        <header className="topbar">
          <div><p className="eyebrow">BETHEL NJROTC SUPPLY</p><h1>{pageTitle(tab)}</h1></div>
          <div className="top-actions"><span className="sync"><Wifi size={15} /> Local draft</span><button className="icon-button" aria-label="Settings"><Settings size={20} /></button><span className="top-avatar">RW</span></div>
        </header>

        {notice && <button className="notice" onClick={() => setNotice('')} aria-label="Dismiss notification">{notice} ×</button>}
        {tab === 'count' && <CountView selected={selected} count={count} setCount={(value) => { setCount(value); setData(current => ({ ...current, session: { ...current.session, status: 'draft', counts: { ...current.session.counts, [selected.id]: value } } })) }} step={step} setStep={setStep} query={query} setQuery={setQuery} filtered={filtered} selectItem={selectItem} onSubmit={() => runAction(submitCount, 'Physical count submitted and inventory reconciled.')} session={data.session} />}
        {tab === 'inventory' && <InventoryView items={filtered} allItems={items} query={query} setQuery={setQuery} onAdd={() => setShowAdd(true)} selectItem={(item) => { selectItem(item); setTab('count') }} />}
        {tab === 'cadets' && <CadetsView data={data} onTransaction={(kind, itemId, cadetId) => runAction(current => transact(current, itemId, 1, kind, cadetId), `${kind === 'issue' ? 'Issue' : 'Return'} recorded.`)} />}
        {tab === 'activity' && <ActivityView data={data} />}
        {tab === 'more' && <MoreView data={data} onRollover={() => runAction(current => rollover(current, window.confirm(`Advance from ${current.schoolYear} to ${current.schoolYear + 1}?`)), 'Annual rollover completed.')} />}
      </main>

      <nav className="mobile-nav" aria-label="Mobile navigation">
        {navItems.map(({ id, label, icon: Icon }) => <button className={tab === id ? 'active' : ''} key={id} onClick={() => setTab(id)}><Icon size={21} /><span>{label}</span></button>)}
      </nav>

      {showAdd && <AddItemModal onClose={() => setShowAdd(false)} onSave={(item) => { const created = { ...item, id: crypto.randomUUID(), issued: 0, status: 'Ready' as const }; setData(current => withAudit({ ...current, inventory: [...current.inventory, created] }, 'item.created', `Created ${created.name}`, created.id)); setShowAdd(false) }} />}
    </div>
  )
}

function Brand() {
  return <div className="brand"><img src={`${import.meta.env.BASE_URL}argus-mark.svg`} alt="" /><div><strong>A.R.G.U.S.</strong><span>ASSET READINESS SYSTEM</span></div></div>
}

function pageTitle(tab: Tab) {
  return { count: 'Physical Count', inventory: 'Inventory', cadets: 'Cadets', activity: 'Activity', more: 'Command Center' }[tab]
}

type CountProps = {
  selected: InventoryItem; count: number; setCount: (value: number) => void; step: number; setStep: (value: number) => void
  query: string; setQuery: (value: string) => void; filtered: InventoryItem[]; selectItem: (item: InventoryItem) => void
  onSubmit: () => void; session: AppData['session']
}

function CountView({ selected, count, setCount, step, setStep, query, setQuery, filtered, selectItem, onSubmit, session }: CountProps) {
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
      <div className="session-chip"><span className="pulse" /><div><small>{session.status.toUpperCase()}</small><strong>{session.name}</strong></div><ChevronDown size={16} /></div>
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
        <button className="undo-button" onClick={() => setCount(selected.onHand)}><RotateCcw size={16} /> Reset to official count</button>
      </section>

      <aside className="review-card">
        <div className="card-title"><span><ClipboardCheck size={18} /></span><div><small>LIVE COMPARISON</small><h3>Count review</h3></div></div>
        <div className="stat-row"><span>Official on hand<small>Before this count</small></span><strong>{selected.onHand}</strong></div>
        <div className="stat-row"><span>Physical count<small>Combined session</small></span><strong>{count}</strong></div>
        <div className={difference === 0 ? 'difference match' : 'difference warning'}><span>{difference === 0 ? <ShieldCheck /> : <Activity />}</span><div><small>DIFFERENCE</small><strong>{difference > 0 ? '+' : ''}{difference} units</strong><p>{difference === 0 ? 'Inventory matches the record.' : 'Administrator review required.'}</p></div></div>
        <div className="contributors"><div className="contributor-avatars"><span>RW</span><span>KM</span><span>+1</span></div><p><strong>3 staff counting</strong><br/>Updated just now</p><Cloud size={18} /></div>
        <button className="primary-button" onClick={onSubmit}>Review & submit <ArrowRight size={18} /></button>
        <p className="safe-note"><ShieldCheck size={14} /> Draft only—official inventory is unchanged</p>
      </aside>
    </div>
  </div>
}

function InventoryView({ items, allItems, query, setQuery, onAdd, selectItem }: { items: InventoryItem[]; allItems: InventoryItem[]; query: string; setQuery: (v: string) => void; onAdd: () => void; selectItem: (i: InventoryItem) => void }) {
  const totals = allItems.reduce((sum, item) => ({ onHand: sum.onHand + item.onHand, issued: sum.issued + item.issued, attention: sum.attention + (item.status === 'Ready' ? 0 : 1) }), { onHand: 0, issued: 0, attention: 0 })
  return <div className="content"><section className="page-intro"><div><p className="eyebrow">SERVICEABLE INVENTORY</p><h2>Every asset, accounted for.</h2><p>Search by item, size, category, or CDMIS NIIN.</p></div><button className="gold-button" onClick={onAdd}><PackagePlus size={18} /> Add item</button></section>
    <div className="summary-grid"><Summary label="On hand" value={String(totals.onHand)} detail={`${allItems.length} tracked variants`} /><Summary label="Issued" value={String(totals.issued)} detail="Across active cadets" /><Summary label="Needs attention" value={String(totals.attention)} detail="Low stock or count due" accent /></div>
    <div className="table-card"><div className="table-tools"><div className="inline-search"><Search size={18}/><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search inventory…" /></div><button><Settings size={17}/> Filters</button></div>
      <div className="inventory-list">{items.map((item) => <button className="inventory-row" key={item.id} onClick={() => selectItem(item)}><span className="category-mark">{item.name.slice(0,2).toUpperCase()}</span><span className="item-name"><strong>{item.name}</strong><small>{item.category} · {item.niin}</small></span><span><small>SIZE</small><b>{item.size}</b></span><span><small>ON HAND</small><b>{item.onHand}</b></span><span><small>ISSUED</small><b>{item.issued}</b></span><em className={item.status === 'Ready' ? 'ready' : 'attention'}>{item.status}</em><ArrowRight size={18}/></button>)}</div>
    </div>
  </div>
}

function Summary({ label, value, detail, accent = false }: { label: string; value: string; detail: string; accent?: boolean }) {
  return <div className={accent ? 'summary-card accent' : 'summary-card'}><small>{label.toUpperCase()}</small><strong>{value}</strong><p>{detail}</p></div>
}

function CadetsView({ data, onTransaction }: { data: AppData; onTransaction: (kind: 'issue' | 'return', itemId: string, cadetId: string) => void }) {
  const [selectedCadet, setSelectedCadet] = useState(data.cadets[0]?.id ?? '')
  const [itemId, setItemId] = useState(data.inventory[0]?.id ?? '')
  return <div className="content"><section className="page-intro"><div><p className="eyebrow">PERSONNEL ACCOUNTABILITY · {data.schoolYear}</p><h2>Cadet property records.</h2><p>Issue and return quantities update both inventory and cadet totals.</p></div><div className="transaction-bar"><select aria-label="Cadet" value={selectedCadet} onChange={e => setSelectedCadet(e.target.value)}>{data.cadets.filter(c => c.active).map(c => <option value={c.id} key={c.id}>{c.name}</option>)}</select><select aria-label="Transaction item" value={itemId} onChange={e => setItemId(e.target.value)}>{data.inventory.map(i => <option value={i.id} key={i.id}>{i.name} · {i.size}</option>)}</select><button className="gold-button" onClick={() => onTransaction('issue', itemId, selectedCadet)}>Issue 1</button><button onClick={() => onTransaction('return', itemId, selectedCadet)}>Return 1</button></div></section><div className="table-card"><div className="cadet-grid">{data.cadets.map(cadet => <button className="cadet-card" key={cadet.id}><span className="large-avatar">{cadet.initials}</span><span><strong>{cadet.name}</strong><small>{cadet.level} · {cadet.configuration}{!cadet.active && ' · Archived'}</small></span><div><b>{cadet.items}</b><small>Issued items</small></div><em className={cadet.status === 'Clear' ? 'ready' : 'attention'}>{cadet.status}</em><ArrowRight size={18}/></button>)}</div></div></div>
}

function ActivityView({ data }: { data: AppData }) {
  return <div className="content"><section className="page-intro"><div><p className="eyebrow">AUDIT TRAIL</p><h2>Nothing changes silently.</h2><p>A local, append-only record of actions and outcomes.</p></div></section><div className="timeline">{data.audit.length ? data.audit.map(event => <div className="event" key={event.id}><span className="event-icon"><History/></span><div><strong>{event.summary}</strong><p>{event.type}</p></div><span className="event-user">{event.actor.split(' ').map(v => v[0]).join('')}</span><time>{new Date(event.at).toLocaleString()}</time></div>) : <div className="empty-state">No activity yet. Completed actions will appear here.</div>}</div></div>
}

function MoreView({ data, onRollover }: { data: AppData; onRollover: () => void }) {
  const options = [{ icon: PackagePlus, title: 'Issue bundles', desc: `${data.bundles.length} configured uniform set` },{ icon: Archive, title: 'Still needed', desc: 'Track incomplete cadet issues' },{ icon: Users, title: 'Roster administration', desc: 'Import, edit, and prepare annual rollover' },{ icon: ShieldCheck, title: 'Rollover safeguards', desc: 'Active counts must be resolved first' },{ icon: History, title: 'Audit history', desc: `${data.audit.length} protected local events` },{ icon: Settings, title: 'System settings', desc: 'Configure sizes, categories, and alerts' }]
  return <div className="content"><section className="page-intro"><div><p className="eyebrow">ADMINISTRATION · SCHOOL YEAR {data.schoolYear}</p><h2>Command center.</h2><p>All data is stored offline on this device.</p></div><button className="gold-button" onClick={onRollover}>Begin annual rollover</button></section><div className="command-grid">{options.map(({icon:Icon,title,desc}) => <button key={title}><span><Icon/></span><div><strong>{title}</strong><p>{desc}</p></div><ArrowRight/></button>)}</div></div>
}

function AddItemModal({ onClose, onSave }: { onClose: () => void; onSave: (item: Omit<InventoryItem, 'id' | 'issued' | 'status'>) => void }) {
  const [name, setName] = useState(''); const [category, setCategory] = useState(''); const [size, setSize] = useState(''); const [niin, setNiin] = useState(''); const [qty, setQty] = useState(0)
  return <div className="modal-backdrop" role="presentation" onMouseDown={onClose}><form className="modal" onSubmit={(e) => { e.preventDefault(); const resolvedSize = size || 'No size'; onSave({ name, category, sizes: resolvedSize.split(',').map(value => value.trim()).filter(Boolean), size: resolvedSize.split(',')[0].trim(), niin: niin || 'Not assigned', onHand: qty, reorderAt: 0, countBy: 1 }) }} onMouseDown={(e) => e.stopPropagation()}><div className="modal-heading"><div><p className="eyebrow">INVENTORY ADMINISTRATION</p><h2>Add a new item</h2></div><button type="button" onClick={onClose}>×</button></div><p>Create the core item now. Sizes and ordering details remain editable.</p><label>Item name<input required value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Navy PT Shirt" /></label><div className="form-grid"><label>Category<input required value={category} onChange={e => setCategory(e.target.value)} placeholder="PT Gear" /></label><label>Size or variant<input value={size} onChange={e => setSize(e.target.value)} placeholder="Medium" /></label><label>CDMIS NIIN<input value={niin} onChange={e => setNiin(e.target.value)} placeholder="Optional" /></label><label>Initial on hand<input type="number" min="0" value={qty} onChange={e => setQty(Number(e.target.value))} /></label></div><div className="modal-actions"><button type="button" onClick={onClose}>Cancel</button><button className="primary-button" type="submit">Add item <ArrowRight size={17}/></button></div></form></div>
}

export default App
