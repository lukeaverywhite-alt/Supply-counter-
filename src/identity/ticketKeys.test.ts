import { describe, expect, it } from 'vitest'
import { PrivateKey } from '@bsv/sdk'
import { isTestnetAddress } from '../chain/codec'
import { deriveTicketKeys, newTicketEcdhKeyPair, newTicketId, ticketKeyScalar } from './ticketKeys'
import { makeTicketSecret } from './ticketCode'

const secret = (fill: number) => new Uint8Array(16).fill(fill)

describe('ticket keys derived from the ticket secret (ADR 012)', () => {
  it('derives the same ticket key, address and wrapping key from the same secret, and different ones from another', async () => {
    const one = await deriveTicketKeys(secret(7)), again = await deriveTicketKeys(secret(7)), other = await deriveTicketKeys(secret(8))
    expect(again.address).toBe(one.address)
    expect(again.publicIdentity).toBe(one.publicIdentity)
    expect(other.address).not.toBe(one.address)
    expect(isTestnetAddress(one.address)).toBe(true)
    expect(one.privateKey.toAddress('testnet')).toBe(one.address)
    expect(one.publicIdentity).toMatch(/^k1:0[23][0-9a-f]{64}$/)
    // The wrapping key is AES-256-GCM and the same secret gives the same key: what one side seals the other opens.
    const nonce = new Uint8Array(12), data = new TextEncoder().encode('hello')
    const sealed = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, one.wrappingKey, data)
    expect(new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, again.wrappingKey, sealed))).toBe('hello')
    await expect(crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, other.wrappingKey, sealed)).rejects.toThrow()
  })

  it('keeps the ticket key and the wrapping key independent: the wrapping key is not the ticket key', async () => {
    const keys = await deriveTicketKeys(secret(3))
    expect(keys.wrappingKey.algorithm).toMatchObject({ name: 'AES-GCM', length: 256 })
    expect(keys.wrappingKey.extractable).toBe(false)
    // the private key never appears in the public identity
    expect(keys.publicIdentity).not.toContain(keys.privateKey.toHex())
  })

  it('derives again with ticket-key/1, ticket-key/2, ... when the scalar is zero or not below the curve order', () => {
    const bytes = (hex: string) => Uint8Array.from(hex.match(/../g)!.map(pair => parseInt(pair, 16)))
    expect(ticketKeyScalar(bytes('00'.repeat(32)))).toBeUndefined()
    expect(ticketKeyScalar(bytes('ff'.repeat(32)))).toBeUndefined()
    expect(ticketKeyScalar(bytes('fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141'))).toBeUndefined()
    expect(ticketKeyScalar(bytes('fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364140'))).toBeInstanceOf(PrivateKey)
    expect(ticketKeyScalar(bytes('01'.repeat(32)))?.toAddress('testnet')).toBe('mrcNu71ztWjAQA6ww9kHiW3zBWSQidHXTQ')
  })

  it('makes ticket ids t- plus 20 hex digits, never repeated', () => {
    const ids = new Set(Array.from({ length: 50 }, () => newTicketId()))
    expect(ids.size).toBe(50)
    for (const id of ids) expect(id).toMatch(/^t-[0-9a-f]{20}$/)
  })

  it('makes a random P-256 ECDH key pair whose private half can be kept as JWK JSON and whose public half is a key', async () => {
    const pair = await newTicketEcdhKeyPair(), other = await newTicketEcdhKeyPair()
    expect(pair.publicKey).not.toBe(other.publicKey)
    const jwk = JSON.parse(pair.privateJwk) as JsonWebKey
    expect(jwk).toMatchObject({ kty: 'EC', crv: 'P-256' })
    const imported = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits'])
    const peer = await crypto.subtle.importKey('spki', Uint8Array.from(atob(pair.publicKey.replaceAll('-', '+').replaceAll('_', '/') + '=='.slice(0, (4 - pair.publicKey.length % 4) % 4)), c => c.charCodeAt(0)), { name: 'ECDH', namedCurve: 'P-256' }, false, [])
    expect(imported.type).toBe('private'); expect(peer.type).toBe('public')
  })

  it('works with a real random ticket secret', async () => {
    const keys = await deriveTicketKeys(makeTicketSecret())
    expect(keys.address).toMatch(/^[mn]/)
  })
})
