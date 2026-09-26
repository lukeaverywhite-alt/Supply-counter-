import { describe, expect, it } from 'vitest'
import { createWrappedApplicationCredential, unlockWrappedApplicationCredential } from './identity'

describe('password-wrapped per-user application credentials', () => {
  it('creates unique credentials and unlocks a non-exportable signer', async () => {
    const a = await createWrappedApplicationCredential('correct horse 7 battery')
    const b = await createWrappedApplicationCredential('correct horse 7 battery')
    expect(a.publicIdentity).not.toBe(b.publicIdentity)
    expect(JSON.stringify(a)).not.toContain('correct horse')
    const signer = await unlockWrappedApplicationCredential(a, 'correct horse 7 battery')
    const signature = await signer.sign('event')
    expect(await signer.verify('event', signature, a.publicIdentity)).toBe(true)
  })

  it('rejects weak and incorrect passwords and authenticated-data tampering', async () => {
    await expect(createWrappedApplicationCredential('short')).rejects.toThrow('12 characters')
    const record = await createWrappedApplicationCredential('strong password 123')
    await expect(unlockWrappedApplicationCredential(record, 'wrong password 123')).rejects.toThrow('incorrect or')
    await expect(unlockWrappedApplicationCredential({ ...record, publicIdentity: `${record.publicIdentity}x` }, 'strong password 123')).rejects.toThrow('incorrect or')
  })
})
