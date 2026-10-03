import type { UnitStatus } from '../../unit/runtime'

/** The network did not take the ticket yet (offline, an error, or a wallet that needs coins), so it is saved on this phone and goes out later. */
export const ticketWaiting = (status: Pick<UnitStatus, 'state' | 'needsFunding'>) => status.state === 'offline' || status.state === 'error' || Boolean(status.needsFunding)
export const TICKET_WAITING = 'is saved on this phone and goes out when the network is reachable. The cadet can use the code after that'
