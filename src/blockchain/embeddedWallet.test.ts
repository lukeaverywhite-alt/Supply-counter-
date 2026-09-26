import { describe, expect, it } from 'vitest'
import { EmbeddedTestnetWallet } from './EmbeddedTestnetWallet'

const storage = () => { const values = new Map<string,string>(); return { getItem:(key:string)=>values.get(key)??null, setItem:(key:string,value:string)=>void values.set(key,value), values } }

describe('embedded BSV testnet wallet', () => {
  it('creates an encrypted vault, unlocks it, and never persists the password', async () => {
    const local = storage(), fetcher = async()=>new Response('[]',{status:200}), wallet = new EmbeddedTestnetWallet(local,fetcher as typeof fetch)
    expect(await wallet.getStatus()).toMatchObject({mode:'EMBEDDED',requiresSetup:true})
    const created = await wallet.create('correct horse battery staple')
    expect(created).toMatchObject({connection:'CONNECTED',balanceSatoshis:0})
    const persisted = [...local.values.values()][0]
    expect(persisted).not.toContain('correct horse battery staple')
    expect(persisted).not.toMatch(/(?:K|L|c)[1-9A-HJ-NP-Za-km-z]{50,51}/)
    wallet.lock()
    expect(await wallet.getStatus()).toMatchObject({requiresUnlock:true,receivingAddress:created.receivingAddress})
    await expect(wallet.unlock('wrong password')).rejects.toThrow(/incorrect/)
    expect(await wallet.unlock('correct horse battery staple')).toMatchObject({connection:'CONNECTED'})
  })

  it('requires a strong local wallet password and rejects arbitrary payments', async () => {
    const wallet = new EmbeddedTestnetWallet(storage(),async()=>new Response('[]') as unknown as Response)
    await expect(wallet.create('short')).rejects.toThrow(/12 characters/)
    await expect(wallet.createAction({outputs:[{lockingScript:'006a',satoshis:2}]})).rejects.toThrow(/one-satoshi/)
  })
})
