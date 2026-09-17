import assert from 'node:assert/strict'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createRelay } from './server.mjs'

const org = 'org_7hF2sL9qQ4wX', token = 'test-token-with-128-bits-minimum', headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
const envelope = (eventId, ciphertextHash = 'a'.repeat(64), ciphertext = Buffer.from(`private:${eventId}`).toString('base64')) => ({ protocol:'ARGUS_PRIVATE_EVENT',protocolVersion:1,organizationId:org,eventId,epochId:'epoch-001',senderPublicIdentity:'mock-public-device-a',algorithm:'AES-256-GCM',nonce:'AAAAAAAAAAAAAAAA',ciphertext,ciphertextHash,signature:'mock-envelope-signature' })
const start = async database => { const relay = createRelay({ database, organizations: { [org]: token }, allowedOrigins:['http://localhost:5173'] }); await new Promise(resolve => relay.server.listen(0,'127.0.0.1',resolve)); return { ...relay, url:`http://127.0.0.1:${relay.server.address().port}` } }
const stop = relay => new Promise(resolve => relay.server.close(resolve))

test('real HTTP clients use durable, isolated, cursor-paginated opaque history', async () => {
  const db = path.join(tmpdir(),`argus-relay-${crypto.randomUUID()}.json`); let relay = await start(db)
  const clientA = input => fetch(`${relay.url}/api/v1/events`,{method:'POST',headers,body:JSON.stringify(input)})
  const clientB = cursor => fetch(`${relay.url}/api/v1/events?organizationId=${org}&cursor=${cursor}&limit=1`,{headers:{authorization:`Bearer ${token}`}})
  const first = envelope('event_network_0001', 'a'.repeat(64), Buffer.from('Jordan Rivera / SDB Jacket Medium').toString('base64'))
  assert.equal((await clientA(first)).status,201)
  assert.deepEqual(await (await clientA(first)).json(),{accepted:true,duplicate:true,sequence:1})
  assert.equal((await clientA({...first,ciphertextHash:'b'.repeat(64)})).status,409)
  assert.equal((await fetch(`${relay.url}/api/v1/events?organizationId=${org}`,{headers:{authorization:'Bearer wrong-wrong-wrong'}})).status,401)
  assert.equal((await clientA(envelope('event_network_0002','c'.repeat(64)))).status,201)
  const page1 = await (await clientB('0')).json(); assert.equal(page1.events.length,1); assert.equal(page1.hasMore,true)
  const page2 = await (await clientB(page1.nextCursor)).json(); assert.equal(page2.events[0].eventId,'event_network_0002')
  await stop(relay); relay = await start(db)
  const recovered = await (await fetch(`${relay.url}/api/v1/events/event_network_0001?organizationId=${org}`,{headers:{authorization:`Bearer ${token}`}})).json()
  assert.equal(recovered.event.eventId,'event_network_0001')
  const bytes = await readFile(db); assert.equal(bytes.includes(Buffer.from('Jordan Rivera')),false); assert.equal(bytes.includes(Buffer.from('SDB Jacket Medium')),false)
  await stop(relay); await rm(db,{force:true})
})

test('corrupt relay state fails closed without overwriting the source', async () => {
  const db = path.join(tmpdir(),`argus-relay-corrupt-${crypto.randomUUID()}.json`), corrupt = '{"version":1,"nextSequence":1,"events":"lost-history"}'
  await writeFile(db, corrupt)
  assert.throws(() => createRelay({ database:db, organizations:{ [org]:token } }), /corrupt|unsupported/)
  assert.equal(await readFile(db, 'utf8'), corrupt)
  await rm(db,{force:true})
})
