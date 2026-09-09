export type InventoryItem = {
  id: number
  name: string
  category: string
  size: string
  niin: string
  onHand: number
  issued: number
  status: 'Ready' | 'Low stock' | 'Count due'
}

export type Cadet = {
  id: number
  initials: string
  name: string
  level: string
  configuration: string
  items: number
  status: 'Clear' | 'Still needed' | 'Return pending'
}
