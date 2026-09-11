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

export type DomainEventType = 'INVENTORY_ITEM_CREATED' | 'INVENTORY_COUNT_SUBMITTED' | 'ITEM_ISSUED' | 'ITEM_RETURNED' | 'ANNUAL_ROLLOVER_COMPLETED'
export type AuditStatus = 'LOCAL' | 'QUEUED_FOR_AUDIT' | 'SUBMITTING' | 'SUBMITTED' | 'CONFIRMED' | 'FAILED'
export type BlockchainNetwork = 'MOCK' | 'TESTNET'

export type AuditEvent = {
  eventVersion: 1
  eventId: string
  timestamp: string
  actorId: string
  type: DomainEventType
  summary: string
  entityId: string
  data: Record<string, string | number | boolean>
  previousEventHash?: string
  audit: {
    status: AuditStatus
    targetNetwork: BlockchainNetwork
    submittedNetwork?: BlockchainNetwork
    eventHash?: string
    transactionId?: string
    publicIdentity?: string
    signature?: string
    error?: string
  }
}

export type AppData = {
  version: 3
  schoolYear: number
  inventory: InventoryItem[]
  cadets: Cadet[]
  bundles: Bundle[]
  stillNeeded: StillNeeded[]
  session: CountSession
  audit: AuditEvent[]
}
