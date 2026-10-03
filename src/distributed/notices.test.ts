import { describe, expect, it } from 'vitest'
import { AuthorizationService, ROLE_PERMISSIONS, issueCredential } from '../auth/authorization'
import { MockIdentityProvider } from '../identity/identity'
import { MemoryRepository, type RepositoryState } from '../storage/repository'
import { MockSyncProvider } from '../sync/mock'
import { canonicalize } from './canonical'
import { ArgusReplica, MAX_NOTICE_LENGTH } from './replica'
import type { ArgusRole, SignedArgusEvent } from './types'

const root = new MockIdentityProvider('unit-root')
async function unit(roles: Record<string, ArgusRole>) {
  const authorization = new AuthorizationService(await root.getPublicIdentity(), new MockIdentityProvider('verifier'))
  const provider = new MockSyncProvider(), replicas: Record<string, ArgusReplica> = {}
  for (const [name, role] of Object.entries(roles)) {
    const identity = new MockIdentityProvider(name)
    await authorization.acceptCredential(await issueCredential(root, { subjectPublicIdentity: await identity.getPublicIdentity(), role, permissions: [...ROLE_PERMISSIONS[role]], issuedAt: '2020-01-01T00:00:00.000Z' }))
    replicas[name] = new ArgusReplica(new MemoryRepository(), identity, authorization, provider, 'unit-a', { genesisCatalog: true })
    await replicas[name].initialize(); replicas[name].online = false
  }
  return { replicas }
}
const cadet = async (replica: ArgusReplica) => (await replica.createCadet({ gender: 'Female', nsLevel: 'NS2', status: 'ACTIVE' })).entityId
const events = async (replica: ArgusReplica) => (await replica.snapshot()).events.map(record => record.event)
async function forged(author: string, entityId: string, payload: Record<string, unknown>, eventId: string) {
  const unsigned = { protocol: 'ARGUS' as const, protocolVersion: 1 as const, organizationId: 'unit-a', eventVersion: 1 as const, eventId, eventType: 'NOTICE_SENT' as const, entityId, actorPublicIdentity: `mock:${author}`, timestamp: '2026-10-03T12:00:00.000Z', clock: 1_000, payload }
  return { ...unsigned, signature: await new MockIdentityProvider(author).sign(canonicalize(unsigned)) } as SignedArgusEvent
}
const good = (noticeId: string, author = 'master') => ({ noticeId, audience: 'all', text: 'Military ball: bring your SDBs', sentBy: `mock:${author}`, sentAt: '2026-10-03T12:00:00.000Z' })

describe('notices in the unit log (ADR 013, mw-kmgi38.5)', () => {
  it('a Master’s sendNotice to all folds NOTICE_SENT into notices with who sent it and when', async () => {
    const { replicas: { master } } = await unit({ master: 'MASTER' })
    const event = await master.sendNotice('all', '  Military ball: bring your SDBs ')
    expect(event.eventType).toBe('NOTICE_SENT')
    const [notice] = (await master.snapshot()).notices
    expect(notice).toMatchObject({ noticeId: event.entityId, audience: 'all', text: 'Military ball: bring your SDBs', sentBy: 'mock:master', sentAt: event.timestamp, eventId: event.eventId })
    expect(event.payload).toEqual({ noticeId: event.entityId, audience: 'all', text: 'Military ball: bring your SDBs', sentBy: 'mock:master', sentAt: event.timestamp })
  })

  it('a notice to one cadet records the cadet, and a cadet the unit does not have is refused', async () => {
    const { replicas: { master } } = await unit({ master: 'MASTER' })
    const cadetId = await cadet(master)
    await master.createCadetChannel(cadetId)
    const event = await master.sendNotice({ cadetId }, 'Come to supply Thursday')
    expect(event.payload.audience).toEqual({ cadetId })
    expect((await master.snapshot()).notices[0].audience).toEqual({ cadetId })
    await expect(master.sendNotice({ cadetId: 'cadet_nobody' }, 'Hello')).rejects.toThrow('Cadet was not found.')
  })

  it('refuses a cadet with no channel in the command: This cadet has no phone yet', async () => {
    const { replicas: { master } } = await unit({ master: 'MASTER' })
    const cadetId = await cadet(master)
    await expect(master.sendNotice({ cadetId }, 'Hello')).rejects.toThrow('This cadet has no phone yet')
    expect((await master.snapshot()).notices).toEqual([])
  })

  it('refuses text that is empty or over 500 characters, with a message, and accepts exactly 500', async () => {
    const { replicas: { master } } = await unit({ master: 'MASTER' })
    expect(MAX_NOTICE_LENGTH).toBe(500)
    await expect(master.sendNotice('all', 'x'.repeat(501))).rejects.toThrow('A notice can be at most 500 characters.')
    await expect(master.sendNotice('all', '   ')).rejects.toThrow('Write the notice first.')
    await master.sendNotice('all', 'x'.repeat(500))
    expect((await master.snapshot()).notices).toHaveLength(1)
  })

  it('a Supply Assistant’s send is refused, and the fold refuses one forged in their name', async () => {
    const { replicas: { master, assistant } } = await unit({ master: 'MASTER', assistant: 'SUPPLY_ASSISTANT' })
    await expect(assistant.sendNotice('all', 'Hello')).rejects.toThrow('Unauthorized: notices.send is required.')
    await master.receive(await forged('assistant', 'n-1', good('n-1', 'assistant'), 'from-assistant'))
    const state = await master.snapshot()
    expect(state.notices).toEqual([])
    expect(state.rejected).toEqual([expect.objectContaining({ eventId: 'from-assistant', reason: 'Unauthorized: notices.send is required.' })])
  })

  it('the fold re-checks every payload: text, audience, author, id, time', async () => {
    const { replicas: { master } } = await unit({ master: 'MASTER' })
    const cases: Array<[string, string, Record<string, unknown>, RegExp]> = [
      ['long', 'n-long', { ...good('n-long'), text: 'x'.repeat(501) }, /Corrupted notice/],
      ['blank', 'n-blank', { ...good('n-blank'), text: ' ' }, /Corrupted notice/],
      ['audience', 'n-aud', { ...good('n-aud'), audience: 'everyone' }, /Corrupted notice/],
      ['no-cadet', 'n-nc', { ...good('n-nc'), audience: { cadetId: 'cadet_x' } }, /Cadet projection is missing/],
      ['liar', 'n-liar', { ...good('n-liar'), sentBy: 'mock:someone-else' }, /Corrupted notice/],
      ['entity', 'n-other', good('n-entity'), /Corrupted notice/],
      ['time', 'n-time', { ...good('n-time'), sentAt: 'yesterday' }, /Corrupted notice/],
    ]
    for (const [eventId, entityId, payload] of cases) await master.receive(await forged('master', entityId, payload, eventId))
    const state = await master.snapshot()
    expect(state.notices).toEqual([])
    for (const [eventId, , , reason] of cases) expect(state.rejected.find(record => record.eventId === eventId)?.reason).toMatch(reason)
  })

  it('a notice ID is used once: a second event with it is a visible rejection', async () => {
    const { replicas: { master } } = await unit({ master: 'MASTER' })
    await master.receive(await forged('master', 'n-1', good('n-1'), 'first'))
    await master.receive(await forged('master', 'n-1', { ...good('n-1'), text: 'Different' }, 'second'))
    const state = await master.snapshot()
    expect(state.notices.map(notice => notice.text)).toEqual(['Military ball: bring your SDBs'])
    expect(state.rejected).toEqual([expect.objectContaining({ eventId: 'second', reason: 'Notice ID already exists.' })])
  })

  it('two devices receiving notices in different orders end byte-identical', async () => {
    const { replicas: { master, officer, fresh } } = await unit({ master: 'MASTER', officer: 'SUPPLY_OFFICER', fresh: 'SUPPLY_ASSISTANT' })
    const cadetId = await cadet(master)
    await master.createCadetChannel(cadetId)
    await officer.receiveMany(await events(master))
    await master.sendNotice('all', 'One'); await officer.sendNotice('all', 'Two'); await officer.sendNotice({ cadetId }, 'Three')
    await officer.receiveMany(await events(master)); await master.receiveMany(await events(officer))
    await fresh.receiveMany([...(await events(officer))].reverse())
    const visible = (state: RepositoryState) => canonicalize({ notices: state.notices, rejected: state.rejected })
    const states = await Promise.all([master, officer, fresh].map(replica => replica.snapshot()))
    expect(states[0].notices).toHaveLength(3)
    expect(visible(states[1])).toBe(visible(states[0])); expect(visible(states[2])).toBe(visible(states[0]))
  })
})
