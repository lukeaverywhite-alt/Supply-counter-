import type { Server } from 'node:http'
export function createRelay(options: { database: string; organizations: Record<string,string>; allowedOrigins: string[]; rateLimit?: number }): { server: Server; close: () => void }
