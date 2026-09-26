import { AuthorizationService, ROLE_PERMISSIONS, issueCredential } from '../auth/authorization'
import { MockIdentityProvider } from '../identity/identity'
import { IndexedDbRepository } from '../storage/repository'
import { DistributedAppController } from '../distributed/appIntegration'
import { DurableEncryptedEventSyncProvider } from './eventSyncProvider'
import { SharedSecretEpochKeyDistribution } from './keys'
import { RemotePrivateHistoryProvider } from './remote'
import { canonicalize } from '../distributed/canonical'
import type { SignedArgusEvent } from '../distributed/types'

export const SYNC_ENROLLMENT_KEY = 'argus.sync.enrollment.v1'
export type SyncEnrollment = { endpoint: string; organizationId: string; accessToken: string }

export function loadSyncEnrollment(storage: Pick<Storage, 'getItem'> = localStorage): SyncEnrollment | undefined {
  const raw = storage.getItem(SYNC_ENROLLMENT_KEY)
  if (!raw) return undefined
  try {
    const value = JSON.parse(raw) as SyncEnrollment
    if (!value.endpoint || !value.organizationId || value.accessToken.length < 16) return undefined
    return value
  } catch { return undefined }
}

export function saveSyncEnrollment(value: SyncEnrollment, storage: Pick<Storage, 'setItem'> = localStorage) {
  if (!/^https:\/\//.test(value.endpoint) && !/^http:\/\/(localhost|127\.0\.0\.1|\[::1\]|[^/]+)(:\d+)?$/.test(value.endpoint)) throw new Error('Enter a valid HTTPS relay URL (HTTP is allowed only for local/LAN testing).')
  if (!/^[A-Za-z0-9_-]{8,160}$/.test(value.organizationId)) throw new Error('Enter the organization ID supplied by the relay administrator.')
  if (value.accessToken.length < 16) throw new Error('The enrollment secret must contain at least 16 characters.')
  storage.setItem(SYNC_ENROLLMENT_KEY, JSON.stringify(value))
}

export async function createRuntimeController(storage: Pick<Storage, 'getItem'> = localStorage) {
  const enrollment = loadSyncEnrollment(storage)
  if (!enrollment) return new DistributedAppController()
  const identity = new MockIdentityProvider('supply-officer-development')
  const root = new MockIdentityProvider('root-development')
  const authorization = new AuthorizationService(await root.getPublicIdentity(), identity)
  await authorization.acceptCredential(await issueCredential(root, { subjectPublicIdentity: await identity.getPublicIdentity(), role: 'SUPPLY_OFFICER', permissions: [...ROLE_PERMISSIONS.SUPPLY_OFFICER], issuedAt: '2020-01-01T00:00:00.000Z' }))
  // Keep the existing repository so enrollment immediately uploads durable
  // local events instead of stranding the user's pre-enrollment changes.
  const repository = new IndexedDbRepository('argus-operational-v2')
  await repository.initialize()
  const current = await repository.snapshot()
  if (current.enrollmentMigration?.organizationId !== undefined && current.enrollmentMigration.organizationId !== enrollment.organizationId) {
    throw new Error('This local repository is already bound to another organization. Export it and use a fresh browser profile for the new organization.')
  }
  if (!current.enrollmentMigration) {
    const migrated = await Promise.all(current.events.map(async record => {
      const prior: Partial<SignedArgusEvent> = { ...record.event }
      delete prior.signature
      const unsigned = { ...prior, organizationId: enrollment.organizationId }
      return { ...record, event: { ...unsigned, signature: await identity.sign(canonicalize(unsigned)) } as SignedArgusEvent, syncStatus: 'QUEUED' as const }
    }))
    // This one-time compatibility import and its marker are atomic. Ordinary
    // startup must never rewrite signed bytes or discard prepared ciphertext.
    await repository.transaction(state => {
      state.events = migrated
      state.outbox = migrated.map(record => ({ eventId: record.event.eventId, attempts: 0, status: 'QUEUED' }))
      state.privateSyncOutbox = []
      state.privateSyncDeliveries = []
      state.enrollmentMigration = { version: 1, organizationId: enrollment.organizationId, completedAt: new Date().toISOString(), importedEventIds: migrated.map(record => record.event.eventId) }
    })
  }
  const remote = new RemotePrivateHistoryProvider({ endpoint: enrollment.endpoint, organizationId: enrollment.organizationId, accessToken: () => enrollment.accessToken })
  const keys = new SharedSecretEpochKeyDistribution(enrollment.organizationId, () => enrollment.accessToken)
  const provider = new DurableEncryptedEventSyncProvider('encrypted-relay-v1', repository, remote, identity, keys, enrollment.organizationId)
  return new DistributedAppController(repository, { identity, authorization, provider, organizationId: enrollment.organizationId })
}
