import { canonicalize } from '../distributed/canonical'
import type { ArgusIdentityProvider } from '../identity/identity'
import { verifyTicketSignature } from '../identity/ticketKeys'
import type { ArgusPermission, ArgusRole, AuthorityCredential, AuthorityRevocation } from '../distributed/types'
import { parseTicketRedeemedFact } from '../private-sync/schema'
import type { TicketInvitation, TicketRedeemedFact } from '../private-sync/types'

export const ROLE_PERMISSIONS: Record<ArgusRole, readonly ArgusPermission[]> = {
  MASTER: ['inventory.read', 'inventory.issue', 'inventory.return', 'inventory.count', 'inventory.adjust', 'inventory.create', 'cadets.read', 'cadets.manage', 'calendar.read', 'calendar.write', 'bundles.read', 'bundles.manage', 'audit.read', 'conflicts.resolve', 'users.authorize', 'users.revoke', 'users.manageRoles'],
  INSTRUCTOR: ['inventory.read', 'inventory.issue', 'inventory.return', 'inventory.count', 'cadets.read', 'calendar.read', 'audit.read'],
  SUPPLY_OFFICER: ['inventory.read', 'inventory.issue', 'inventory.return', 'inventory.count', 'inventory.adjust', 'inventory.create', 'cadets.read', 'cadets.manage', 'calendar.read', 'calendar.write', 'bundles.read', 'bundles.manage', 'audit.read', 'conflicts.resolve'],
  SUPPLY_ASSISTANT: ['inventory.read', 'inventory.issue', 'inventory.return', 'inventory.count', 'cadets.read', 'calendar.read', 'bundles.read'],
}

type Clock = () => string
const unsigned = <T extends { signature: string }>(value: T) => { const rest: Partial<T> = { ...value }; delete rest.signature; return canonicalize(rest) }

export async function issueCredential(issuer: ArgusIdentityProvider, input: Omit<AuthorityCredential, 'credentialVersion' | 'credentialId' | 'issuedBy' | 'signature'> & { credentialId?: string }, clock: Clock = () => new Date().toISOString()): Promise<AuthorityCredential> {
  const credential = { credentialVersion: 1 as const, credentialId: input.credentialId ?? crypto.randomUUID(), subjectPublicIdentity: input.subjectPublicIdentity, role: input.role, permissions: [...new Set(input.permissions)].sort() as ArgusPermission[], issuedAt: input.issuedAt || clock(), issuedBy: await issuer.getPublicIdentity(), ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}) }
  return { ...credential, signature: await issuer.sign(canonicalize(credential)) }
}

export async function issueRevocation(issuer: ArgusIdentityProvider, credential: AuthorityCredential, effectiveAt: string, revocationId = crypto.randomUUID()): Promise<AuthorityRevocation> {
  const value = { revocationVersion: 1 as const, revocationId, credentialId: credential.credentialId, subjectPublicIdentity: credential.subjectPublicIdentity, effectiveAt, issuedBy: await issuer.getPublicIdentity() }
  return { ...value, signature: await issuer.sign(canonicalize(value)) }
}

/**
 * A member admitted by ticket (ADR 012). Nobody signs this credential as such: it stands on its proof, the TICKET_REDEEMED fact,
 * whose invitation the issuer signed (authority -> ticket) and whose redemption the ticket key signed (ticket -> device). Its ID
 * is the ticket's, so it is revoked and replaced like any other credential.
 */
export type TicketCredential = AuthorityCredential & { ticket: TicketRedeemedFact }
export const isTicketCredential = (credential: AuthorityCredential): credential is TicketCredential => { const proof = (credential as Partial<TicketCredential>).ticket; return typeof proof === 'object' && proof !== null }
/** The credential a TICKET_REDEEMED fact stands for: the invitation's role from the moment of redemption, issued by the invitation's signer. */
export function ticketCredential(fact: TicketRedeemedFact): TicketCredential {
  const { invitation, redemption } = fact
  return { credentialVersion: 1, credentialId: fact.ticketId, subjectPublicIdentity: redemption.subjectPublicIdentity, role: invitation.role, permissions: [...new Set(ROLE_PERMISSIONS[invitation.role])].sort() as ArgusPermission[], issuedAt: redemption.redeemedAt, issuedBy: invitation.issuedBy, signature: redemption.signature, ticket: { ticketId: fact.ticketId, invitation, issuerCredentials: fact.issuerCredentials, redemption } }
}
const isoTime = (value: string) => !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value

export class AuthorizationService {
  private credentials = new Map<string, AuthorityCredential>()
  private revocations = new Map<string, AuthorityRevocation>()
  /** Tickets redeemed twice by validly signed redemptions (a leaked code): neither redemption admits anyone, whichever arrived first. */
  private contested = new Set<string>()
  constructor(private readonly rootIdentity: string, private readonly verifier: ArgusIdentityProvider) {}

  private credentialActiveAt(credential: AuthorityCredential, at: string) {
    const revocation = this.revocations.get(credential.credentialId)
    return credential.issuedAt <= at && (!credential.expiresAt || credential.expiresAt > at) && (!revocation || revocation.effectiveAt > at)
  }

  /** Whether the credential's chain up to the unit authority holds: its issuer could authorize (or, for a ticket, issue that ticket). */
  private chainValid(credential: AuthorityCredential, seen = new Set<string>()): boolean {
    return isTicketCredential(credential) ? this.ticketChainValid(credential, seen) : this.issuerCanAuthorize(credential.issuedBy, credential.issuedAt, seen)
  }
  private issuerCanAuthorize(issuer: string, at: string, seen = new Set<string>()): boolean {
    if (issuer === this.rootIdentity) return true
    if (seen.has(issuer)) return false
    seen.add(issuer)
    return [...this.credentials.values()].some(c => c.subjectPublicIdentity === issuer && c.role === 'MASTER' && c.permissions.includes('users.authorize') && this.credentialActiveAt(c, at) && this.chainValid(c, seen))
  }
  private ticketChainValid(credential: TicketCredential, seen = new Set<string>()) {
    const { invitation, redemption } = credential.ticket
    return !this.contested.has(credential.credentialId) && this.mayIssueTicket(invitation.issuedBy, invitation.role, invitation.issuedAt, redemption.redeemedAt, seen)
  }
  /**
   * Link 1 of ADR 012: the unit authority may issue any ticket; otherwise a credential of the issuer's, active when the ticket was
   * issued, whose role may make tickets for that role (D4), with a valid chain of its own, and not revoked at or before the redemption:
   * removing an issuer kills their open tickets. Only the authority makes a Master, as for direct credentials.
   */
  private mayIssueTicket(issuer: string, role: ArgusRole, issuedAt: string, redeemedAt: string, seen = new Set<string>()): boolean {
    if (issuer === this.rootIdentity) return true
    if (seen.has(issuer) || role === 'MASTER') return false
    seen.add(issuer)
    const unrevokedAt = (c: AuthorityCredential) => { const revocation = this.revocations.get(c.credentialId); return !revocation || revocation.effectiveAt > redeemedAt }
    return [...this.credentials.values()].some(c => c.subjectPublicIdentity === issuer && !ticketRuleViolation(c.role, role) && this.credentialActiveAt(c, issuedAt) && unrevokedAt(c) && this.chainValid(c, seen))
  }

  /**
   * Verifies a ticket credential's proof: well formed, the credential says exactly what the proof says, redeemed within the ticket's
   * week, the invitation signed by its issuer and the redemption by the ticket key, and the issuer able to issue it (link 1, retried
   * by the caller once the issuer's own credential is known). A second validly redeemed device for one ticket voids the ticket.
   */
  private async acceptTicketCredential(credential: TicketCredential) {
    let fact: TicketRedeemedFact
    try { fact = parseTicketRedeemedFact(credential.ticket) } catch (cause) { throw new Error('Malformed ticket credential.', { cause }) }
    const { invitation, redemption } = fact
    if (canonicalize(credential) !== canonicalize(ticketCredential(fact))) throw new Error('This ticket credential does not match its proof.')
    if (![invitation.issuedAt, invitation.expiresAt, redemption.redeemedAt].every(isoTime)) throw new Error('Malformed ticket credential.')
    if (redemption.redeemedAt < invitation.issuedAt || redemption.redeemedAt >= invitation.expiresAt) throw new Error('This ticket was redeemed outside the ticket’s week.')
    if (!verifyTicketSignature(invitation.ticketPublicKey, unsigned(redemption), redemption.signature)) throw new Error('Invalid ticket signature.')
    await this.verifyInvitation(invitation, fact.issuerCredentials, redemption.redeemedAt)
    const held = this.credentials.get(credential.credentialId)
    if (held && canonicalize(held) === canonicalize(credential)) return
    if (held) { this.contested.add(credential.credentialId); throw new Error('This ticket was already used on another device.') }
    this.credentials.set(credential.credentialId, credential)
  }

  /**
   * Link 1 alone (authority -> ticket), as a device checks a ticket before redeeming it and as every verifier checks a redemption: the
   * issuer signed the invitation and may issue it, judged at `redeemedAt`. The issuer's own chain rides along (`issuerCredentials`, in
   * any order); each is checked against the pinned authority like any credential. An issuer who joined by ticket stands on a ticket
   * credential, which a unit verifier takes only from that ticket's own spend (see UnitEventSyncProvider), never from someone else's
   * proof: otherwise a code holder could fund a ticket of their own and slip a forged one in. Only the fresh device checking a ticket
   * before redeeming it, which holds nothing of the unit yet, takes it from the proof (`acceptTicketProofs`).
   */
  async verifyInvitation(invitation: TicketInvitation, issuerCredentials: AuthorityCredential[], redeemedAt: string, options: { acceptTicketProofs?: boolean } = {}) {
    if (!(await this.verifier.verify(unsigned(invitation), invitation.signature, invitation.issuedBy))) throw new Error('Invalid ticket invitation signature.')
    const offered = issuerCredentials.filter(c => options.acceptTicketProofs || !isTicketCredential(c))
    for (let waiting = offered.filter(c => !this.credentials.has(c.credentialId)), progress = true; waiting.length && progress;) {
      const before = waiting.length
      for (const issuerCredential of waiting) await this.acceptCredential(issuerCredential).catch(() => undefined)
      waiting = waiting.filter(c => !this.credentials.has(c.credentialId)); progress = waiting.length < before
    }
    if (!this.mayIssueTicket(invitation.issuedBy, invitation.role, invitation.issuedAt, redeemedAt)) throw new Error('Ticket issuer is not authorized.')
  }

  async acceptCredential(credential: AuthorityCredential) {
    if (isTicketCredential(credential)) return this.acceptTicketCredential(credential)
    if (credential.credentialVersion !== 1 || !credential.credentialId || !credential.subjectPublicIdentity || !credential.issuedBy || !Array.isArray(credential.permissions)) throw new Error('Malformed authority credential.')
    if (!(await this.verifier.verify(unsigned(credential), credential.signature, credential.issuedBy))) throw new Error('Invalid credential signature.')
    if (!this.issuerCanAuthorize(credential.issuedBy, credential.issuedAt)) throw new Error('Credential issuer is not authorized.')
    // Master authority is delegated only by the unit authority itself, never re-delegated by another Master.
    if (credential.role === 'MASTER' && credential.issuedBy !== this.rootIdentity) throw new Error('Only the unit authority can make someone a Master.')
    if (credential.expiresAt && credential.expiresAt <= credential.issuedAt) throw new Error('Credential expiration is invalid.')
    if (credential.permissions.some(p => !ROLE_PERMISSIONS[credential.role].includes(p))) throw new Error('Credential contains permissions outside its role.')
    this.credentials.set(credential.credentialId, credential)
  }

  async acceptRevocation(revocation: AuthorityRevocation) {
    if (revocation.revocationVersion !== 1 || !this.credentials.has(revocation.credentialId)) throw new Error('Malformed or unknown revocation.')
    if (!(await this.verifier.verify(unsigned(revocation), revocation.signature, revocation.issuedBy))) throw new Error('Invalid revocation signature.')
    if (!this.issuerCanAuthorize(revocation.issuedBy, revocation.effectiveAt)) throw new Error('Revocation issuer is not authorized.')
    if (this.credentials.get(revocation.credentialId)?.role === 'MASTER' && revocation.issuedBy !== this.rootIdentity) throw new Error('Only the unit authority can remove a Master.')
    if (this.credentials.get(revocation.credentialId)?.subjectPublicIdentity !== revocation.subjectPublicIdentity) throw new Error('Revocation names the wrong person.')
    this.revocations.set(revocation.credentialId, revocation)
  }

  hasCredential(credentialId: string) { return this.credentials.has(credentialId) }
  /** The ticket credential admitting this device by this ticket, when its proof was verified and its chain still holds. */
  verifiedTicketCredential(ticketId: string, subjectPublicIdentity: string) { const credential = this.credentials.get(ticketId); return credential && isTicketCredential(credential) && credential.subjectPublicIdentity === subjectPublicIdentity && this.chainValid(credential) ? credential : undefined }
  credentialFor(identity: string, at: string) { return [...this.credentials.values()].find(c => c.subjectPublicIdentity === identity && this.credentialActiveAt(c, at) && this.chainValid(c)) }
  require(identity: string, permission: ArgusPermission, at = new Date().toISOString()) {
    if (identity === this.rootIdentity) return
    // Any active credential may grant it: a device must not decide by which credential it happened to learn first.
    const granted = [...this.credentials.values()].some(c => c.subjectPublicIdentity === identity && c.permissions.includes(permission) && this.credentialActiveAt(c, at) && this.chainValid(c))
    if (!granted) throw new Error(`Unauthorized: ${permission} is required.`)
  }
}

/** The roles an Instructor may make tickets for (ADR 012, D4). MASTER and INSTRUCTOR tickets only a Master makes. */
export const CADET_TICKET_ROLES: readonly ArgusRole[] = ['SUPPLY_OFFICER', 'SUPPLY_ASSISTANT']
/**
 * D4, as a rule of the domain and not only of the screen: a Master may make a ticket for any role; an Instructor only for a
 * cadet role (Supply Officer or Supply Assistant); nobody else makes tickets. Returns the refusal in plain words, or undefined when allowed.
 * It needs no permission of its own (adding one would change existing credentials): the ticket verifier and the unit fold apply this rule.
 */
export function ticketRuleViolation(issuerRole: ArgusRole, ticketRole: ArgusRole): string | undefined {
  if (issuerRole === 'MASTER') return undefined
  if (issuerRole === 'INSTRUCTOR') return CADET_TICKET_ROLES.includes(ticketRole) ? undefined : 'An Instructor can make tickets only for Supply Officers and Supply Assistants. Only a Master can make a Master or Instructor ticket.'
  return 'Only a Master or an Instructor can make tickets.'
}
