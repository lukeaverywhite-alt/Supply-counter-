export type InventoryStatus = 'Healthy' | 'Low' | 'Out of stock' | 'Count due'

export type InventoryItem = {
  id: string
  name: string
  category: string
  sizes: string[]
  size: string
  niin: string
  onHand: number
  issued: number
  reorderAt?: number
  countBy: number
  status: InventoryStatus
}

export type Cadet = {
  id: string
  initials: string
  name: string
  level: string
  configuration: string
  items: number
  status: 'Clear' | 'Still needed' | 'Return pending'
  active: boolean
  schoolYear: number
}

export type BundleLine = { itemId: string; quantity: number }
export type Bundle = { id: string; name: string; lines: BundleLine[] }

export type CountSession = {
  id: string
  name: string
  status: 'draft' | 'active' | 'submitted' | 'needs-approval' | 'reconciled' | 'cancelled'
  counts: Record<string, number>
  startedAt: string
  submittedAt?: string
}

export type StillNeeded = {
  id: string
  cadetId: string
  itemId: string
  requiredSize: string
  quantity: number
  firstNeededAt: string
}

export type AuditEvent = {
  id: string
  at: string
  actor: string
  type: 'item.created' | 'count.submitted' | 'issue.recorded' | 'return.recorded' | 'rollover.completed'
  summary: string
  entityId?: string
  metadata?: Record<string, string | number>
}

export type AppData = {
  version: 2
  schoolYear: number
  inventory: InventoryItem[]
  cadets: Cadet[]
  bundles: Bundle[]
  stillNeeded: StillNeeded[]
  session: CountSession
  audit: AuditEvent[]
}
