import type { AppData } from './types'

export const seedData: AppData = {
  version: 2,
  schoolYear: 2026,
  inventory: [
    { id: 'shirt-pt-m', name: 'Navy PT Shirt', category: 'PT Gear', sizes: ['Small', 'Medium', 'Large', 'X-Large'], size: 'Medium', niin: '8415-EX-1001', onHand: 24, issued: 18, reorderAt: 10, countBy: 1, status: 'Ready' },
    { id: 'shorts-pt-m', name: 'Navy PT Shorts', category: 'PT Gear', sizes: ['Small', 'Medium', 'Large', 'X-Large'], size: 'Medium', niin: '8415-EX-1002', onHand: 8, issued: 21, reorderAt: 10, countBy: 1, status: 'Low stock' },
    { id: 'shirt-nsu-m', name: 'Khaki NSU Shirt', category: 'NSU', sizes: ['Small Classic', 'Medium Classic', 'Large Classic'], size: 'Medium Classic', niin: '8415-EX-2041', onHand: 16, issued: 12, reorderAt: 6, countBy: 1, status: 'Ready' },
    { id: 'shoes-10r', name: 'Black Oxford Shoes', category: 'Footwear', sizes: ['8 Regular', '9 Regular', '10 Regular', '11 Regular'], size: '10 Regular', niin: '8430-EX-1010', onHand: 6, issued: 15, reorderAt: 5, countBy: 1, status: 'Count due' },
    { id: 'undershirt-l', name: 'White Undershirt', category: 'Basics', sizes: ['Small', 'Medium', 'Large', 'X-Large'], size: 'Large', niin: '8420-EX-4102', onHand: 32, issued: 9, reorderAt: 12, countBy: 5, status: 'Ready' },
  ],
  cadets: [
    { id: 'cadet-am', initials: 'AM', name: 'Alex Morgan', level: 'NS1', configuration: 'Standard A', items: 6, status: 'Still needed', active: true, schoolYear: 2026 },
    { id: 'cadet-jc', initials: 'JC', name: 'Jordan Carter', level: 'NS3', configuration: 'Standard B', items: 8, status: 'Clear', active: true, schoolYear: 2026 },
    { id: 'cadet-ts', initials: 'TS', name: 'Taylor Sample', level: 'NS4', configuration: 'Standard A', items: 3, status: 'Return pending', active: true, schoolYear: 2026 },
  ],
  bundles: [{ id: 'bundle-pt', name: 'PT Gear bundle', lines: [{ itemId: 'shirt-pt-m', quantity: 1 }, { itemId: 'shorts-pt-m', quantity: 1 }] }],
  session: { id: 'session-024', name: 'Fall inventory', status: 'draft', counts: { 'shirt-pt-m': 18 }, startedAt: '2026-09-10T09:00:00.000Z' },
  audit: [],
}

// Backwards-compatible named fixtures for small presentational components.
export const inventory = seedData.inventory
export const cadets = seedData.cadets
