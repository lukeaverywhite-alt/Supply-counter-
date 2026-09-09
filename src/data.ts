import type { Cadet, InventoryItem } from './types'

export const inventory: InventoryItem[] = [
  { id: 1, name: 'Navy PT Shirt', category: 'PT Gear', size: 'Medium', niin: '8415-EX-1001', onHand: 24, issued: 18, status: 'Ready' },
  { id: 2, name: 'Navy PT Shorts', category: 'PT Gear', size: 'Medium', niin: '8415-EX-1002', onHand: 8, issued: 21, status: 'Low stock' },
  { id: 3, name: 'Khaki NSU Shirt', category: 'NSU', size: 'Medium Classic', niin: '8415-EX-2041', onHand: 16, issued: 12, status: 'Ready' },
  { id: 4, name: 'Black Oxford Shoes', category: 'Footwear', size: '10 Regular', niin: '8430-EX-1010', onHand: 6, issued: 15, status: 'Count due' },
  { id: 5, name: 'White Undershirt', category: 'Basics', size: 'Large', niin: '8420-EX-4102', onHand: 32, issued: 9, status: 'Ready' },
]

export const cadets: Cadet[] = [
  { id: 1, initials: 'AM', name: 'Alex Morgan', level: 'NS1', configuration: 'Standard A', items: 6, status: 'Still needed' },
  { id: 2, initials: 'JC', name: 'Jordan Carter', level: 'NS3', configuration: 'Standard B', items: 8, status: 'Clear' },
  { id: 3, initials: 'TS', name: 'Taylor Sample', level: 'NS4', configuration: 'Standard A', items: 3, status: 'Return pending' },
]
