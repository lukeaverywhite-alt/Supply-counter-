import type { TicketProjection } from '../distributed/types'

const DAY_MS = 24 * 60 * 60 * 1000

export type TicketListStatus = 'open' | 'redeemed' | 'cancelled' | 'expired'
/** What the issuer sees for one ticket out (D6): name, role, status and, while it can still be used, whole days left. */
export type TicketListEntry = Omit<TicketProjection, 'status'> & { status: TicketListStatus; daysLeft: number }

/**
 * Open tickets run out of time on the viewer's own clock, for display only (ADR 012, check 4): the unit's history holds no
 * clock, so every device folds the same tickets and only this list decides what looks expired. A ticket is expired from the
 * moment of its expiry. A part of a day counts as a day left. Redeemed and cancelled tickets never show days.
 */
export function ticketStatus(ticket: Pick<TicketProjection, 'status' | 'expiresAt'>, now: Date): TicketListStatus {
  if (ticket.status === 'REDEEMED') return 'redeemed'
  if (ticket.status === 'CANCELLED') return 'cancelled'
  return Date.parse(ticket.expiresAt) <= now.getTime() ? 'expired' : 'open'
}
export const ticketDaysLeft = (ticket: Pick<TicketProjection, 'status' | 'expiresAt'>, now: Date) => ticketStatus(ticket, now) === 'open' ? Math.ceil((Date.parse(ticket.expiresAt) - now.getTime()) / DAY_MS) : 0

const RANK: Record<TicketListStatus, number> = { open: 0, expired: 1, redeemed: 2, cancelled: 3 }
/** Every ticket, open ones first (soonest to expire first), then expired, redeemed and cancelled. */
export function listTickets(tickets: readonly TicketProjection[], now: Date = new Date()): TicketListEntry[] {
  return tickets.map(ticket => ({ ...ticket, status: ticketStatus(ticket, now), daysLeft: ticketDaysLeft(ticket, now) }))
    .sort((a, b) => RANK[a.status] - RANK[b.status] || a.expiresAt.localeCompare(b.expiresAt) || a.ticketId.localeCompare(b.ticketId))
}
