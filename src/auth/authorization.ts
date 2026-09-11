import { canonicalize } from '../distributed/canonical'
import type { ArgusIdentityProvider } from '../identity/identity'
import type { ArgusPermission, ArgusRole, AuthorityCredential, AuthorityRevocation } from '../distributed/types'

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

export class AuthorizationService {
  private credentials = new Map<string, AuthorityCredential>()
  private revocations = new Map<string, AuthorityRevocation>()
  constructor(private readonly rootIdentity: string, private readonly verifier: ArgusIdentityProvider) {}

  private credentialActiveAt(credential: AuthorityCredential, at: string) {
    const revocation = this.revocations.get(credential.credentialId)
    return credential.issuedAt <= at && (!credential.expiresAt || credential.expiresAt > at) && (!revocation || revocation.effectiveAt > at)
  }

  private issuerCanAuthorize(issuer: string, at: string, seen = new Set<string>()): boolean {
    if (issuer === this.rootIdentity) return true
    if (seen.has(issuer)) return false
    seen.add(issuer)
    return [...this.credentials.values()].some(c => c.subjectPublicIdentity === issuer && c.role === 'MASTER' && c.permissions.includes('users.authorize') && this.credentialActiveAt(c, at) && this.issuerCanAuthorize(c.issuedBy, c.issuedAt, seen))
  }

  async acceptCredential(credential: AuthorityCredential) {
    if (credential.credentialVersion !== 1 || !credential.credentialId || !credential.subjectPublicIdentity || !credential.issuedBy || !Array.isArray(credential.permissions)) throw new Error('Malformed authority credential.')
    if (!(await this.verifier.verify(unsigned(credential), credential.signature, credential.issuedBy))) throw new Error('Invalid credential signature.')
    if (!this.issuerCanAuthorize(credential.issuedBy, credential.issuedAt)) throw new Error('Credential issuer is not authorized.')
    if (credential.expiresAt && credential.expiresAt <= credential.issuedAt) throw new Error('Credential expiration is invalid.')
    if (credential.permissions.some(p => !ROLE_PERMISSIONS[credential.role].includes(p))) throw new Error('Credential contains permissions outside its role.')
    this.credentials.set(credential.credentialId, credential)
  }

  async acceptRevocation(revocation: AuthorityRevocation) {
    if (revocation.revocationVersion !== 1 || !this.credentials.has(revocation.credentialId)) throw new Error('Malformed or unknown revocation.')
    if (!(await this.verifier.verify(unsigned(revocation), revocation.signature, revocation.issuedBy))) throw new Error('Invalid revocation signature.')
    if (!this.issuerCanAuthorize(revocation.issuedBy, revocation.effectiveAt)) throw new Error('Revocation issuer is not authorized.')
    this.revocations.set(revocation.credentialId, revocation)
  }

  credentialFor(identity: string, at: string) { return [...this.credentials.values()].find(c => c.subjectPublicIdentity === identity && this.credentialActiveAt(c, at) && this.issuerCanAuthorize(c.issuedBy, c.issuedAt)) }
  require(identity: string, permission: ArgusPermission, at = new Date().toISOString()) {
    if (identity === this.rootIdentity) return
    const credential = this.credentialFor(identity, at)
    if (!credential || !credential.permissions.includes(permission)) throw new Error(`Unauthorized: ${permission} is required.`)
  }
}
