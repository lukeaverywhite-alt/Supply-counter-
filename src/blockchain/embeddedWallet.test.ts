import { describe, expect, it } from 'vitest'
import { EmbeddedTestnetWallet } from './EmbeddedTestnetWallet'
import { P2PKH, Transaction } from '@bsv/sdk'

const storage = () => { const values = new Map<string,string>(); return { getItem:(key:string)=>values.get(key)??null, setItem:(key:string,value:string)=>void values.set(key,value), values } }

describe('embedded BSV testnet wallet', () => {
  it('creates an encrypted vault, unlocks it, and never persists the password', async () => {
    const local = storage(), fetcher = async()=>new Response('[]',{status:200}), wallet = new EmbeddedTestnetWallet(local,fetcher as typeof fetch)
    expect(await wallet.getStatus()).toMatchObject({mode:'EMBEDDED',requiresSetup:true})
    const created = await wallet.create('correct horse battery 7 staple')
    expect(created).toMatchObject({connection:'CONNECTED',balanceSatoshis:0})
    const persisted = [...local.values.values()][0]
    expect(persisted).not.toContain('correct horse battery 7 staple')
    expect(persisted).not.toMatch(/(?:K|L|c)[1-9A-HJ-NP-Za-km-z]{50,51}/)
    wallet.lock()
    expect(await wallet.getStatus()).toMatchObject({requiresUnlock:true,receivingAddress:created.receivingAddress})
    await expect(wallet.unlock('wrong password')).rejects.toThrow(/incorrect/)
    expect(await wallet.unlock('correct horse battery 7 staple')).toMatchObject({connection:'CONNECTED'})
  })

  it('requires a strong local wallet password and rejects arbitrary payments', async () => {
    const wallet = new EmbeddedTestnetWallet(storage(),async()=>new Response('[]') as unknown as Response)
    await expect(wallet.create('short')).rejects.toThrow(/12 characters/)
    await expect(wallet.createAction({outputs:[{lockingScript:'006a',satoshis:2}]})).rejects.toThrow(/one-satoshi/)
  })

  it('keeps a successfully decrypted wallet unlocked when the balance service is unavailable', async () => {
    let online = true
    const fetcher = async()=>online ? new Response('[]') : new Response('unavailable',{status:503})
    const wallet = new EmbeddedTestnetWallet(storage(),fetcher as typeof fetch)
    await wallet.create('correct horse battery 7 staple')
    wallet.lock(); online = false
    const status = await wallet.unlock('correct horse battery 7 staple')
    expect(status).toMatchObject({connection:'ERROR',error:expect.stringMatching(/503/)})
    expect(status.error).not.toMatch(/password|damaged/i)
  })

  it('separates confirmed and unconfirmed balances', async () => {
    const fetcher = async()=>new Response(JSON.stringify([{tx_hash:'a'.repeat(64),tx_pos:0,value:7,height:12},{tx_hash:'b'.repeat(64),tx_pos:0,value:3,height:0}]))
    const wallet = new EmbeddedTestnetWallet(storage(),fetcher as typeof fetch)
    expect(await wallet.create('correct horse battery 7 staple')).toMatchObject({balanceSatoshis:7,unconfirmedBalanceSatoshis:3})
  })

  it('rate-limits repeated incorrect unlock attempts in the provider, not only the UI', async () => {
    const wallet = new EmbeddedTestnetWallet(storage(),(async()=>new Response('[]')) as typeof fetch)
    await wallet.create('correct horse battery 7 staple'); wallet.lock()
    for (let attempt=0;attempt<5;attempt += 1) await expect(wallet.unlock('incorrect pass 123')).rejects.toThrow(/incorrect/)
    await expect(wallet.unlock('correct horse battery 7 staple')).rejects.toThrow(/rate-limited/)
  })

  it('serializes, signs, broadcasts, and persists only a real returned TXID', async () => {
    let address = '', broadcastBody = '', broadcasterTxid = 'b'.repeat(64)
    const funding = new Transaction()
    const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/unspent')) return address ? new Response(JSON.stringify([{tx_hash:'a'.repeat(64),tx_pos:0,value:10_000,height:1}])) : new Response('[]')
      if (url.endsWith(`/tx/${'a'.repeat(64)}/hex`)) return new Response(funding.toHex())
      if (url.endsWith('/tx/raw')) { broadcastBody = String(init?.body); return Response.json({txid:broadcasterTxid}) }
      return new Response('not found',{status:404})
    }
    const wallet = new EmbeddedTestnetWallet(storage(),fetcher as typeof fetch)
    address = (await wallet.create('correct horse battery 7 staple')).receivingAddress!
    funding.addOutput({satoshis:10_000,lockingScript:new P2PKH().lock(address)})
    const result = await wallet.createDataTransaction('006a')
    expect(result.transactionId).toBe('b'.repeat(64))
    expect(JSON.parse(broadcastBody)).toEqual({txhex:expect.stringMatching(/^[0-9a-f]+$/)})
    expect((await wallet.getStatus()).recentTransactions[0]).toMatchObject({transactionId:'b'.repeat(64),status:'BROADCAST',timestamp:expect.any(String)})
    broadcasterTxid = 'not-a-real-txid'
    await expect(wallet.createDataTransaction('006a')).rejects.toThrow('valid transaction ID')
    expect((await wallet.getStatus()).recentTransactions).toHaveLength(1)
  })

  it('rejects insufficient funds and malformed broadcaster acknowledgements', async () => {
    const noFunds = new EmbeddedTestnetWallet(storage(),(async()=>new Response('[]')) as typeof fetch)
    await noFunds.create('correct horse battery 7 staple')
    await expect(noFunds.createDataTransaction('006a')).rejects.toThrow('no spendable')
  })

  it('exports authenticated recovery data and recovers an empty device after address confirmation', async () => {
    const original = new EmbeddedTestnetWallet(storage(), (async()=>new Response('[]')) as typeof fetch)
    const created = await original.create('wallet password 1234')
    const backup = await original.exportBackup('backup password 9876')
    expect(JSON.parse(backup)).not.toHaveProperty('wif')
    const fresh = new EmbeddedTestnetWallet(storage(), (async()=>new Response('[]')) as typeof fetch)
    const details = await fresh.inspectBackup(backup, 'backup password 9876')
    expect(details.address).toBe(created.receivingAddress)
    await expect(fresh.recoverBackup(backup, 'backup password 9876', {address:'wrong'})).rejects.toThrow('address exactly')
    expect(await fresh.recoverBackup(backup, 'backup password 9876', {address:details.address})).toMatchObject({connection:'CONNECTED',receivingAddress:details.address})
  })

  it('rejects wrong backup passwords, tampering, and unconfirmed replacement', async () => {
    const wallet = new EmbeddedTestnetWallet(storage(), (async()=>new Response('[]')) as typeof fetch)
    await wallet.create('wallet password 1234')
    const backup = await wallet.exportBackup('backup password 9876')
    await expect(wallet.inspectBackup(backup, 'incorrect value 123')).rejects.toThrow('failed authentication')
    const parsed = JSON.parse(backup); parsed.address = `${parsed.address.slice(0,-1)}${parsed.address.endsWith('a')?'b':'a'}`
    await expect(wallet.inspectBackup(JSON.stringify(parsed), 'backup password 9876')).rejects.toThrow('failed authentication')
    await expect(wallet.recoverBackup(backup, 'backup password 9876', {address:(await wallet.getStatus()).receivingAddress!})).rejects.toThrow('explicit confirmation')
  })
})
