import { Hash, P2PKH, Utils, type LockingScript } from '@bsv/sdk'
import { assertTestnetOnly } from './config'

const ANCHOR_LABEL = 'argus-unit-anchor:'
const KEY_GRANT_ANCHOR_LABEL = 'argus-key-grant-anchor:'
const CHANNEL_LABEL = 'argus-cadet-channel:'
const TESTNET_PREFIX = [0x6f]

/** A fixed, non-spendable 20-byte pubkey hash derived from the organizationId; not a real key, just a chain-visible label. */
function unitAnchorHash(organizationId: string): number[] {
  return Hash.sha256(`${ANCHOR_LABEL}${organizationId}`, 'utf8').slice(0, 20)
}

export function unitAnchorAddress(organizationId: string, network: 'mainnet' | 'testnet' = 'testnet'): string {
  assertTestnetOnly(network.toUpperCase())
  return Utils.toBase58Check(unitAnchorHash(organizationId), TESTNET_PREFIX)
}

/** A distinct anchor address for KEY_GRANT records: key grants and event envelopes never share a
 * transaction history, so a provider scanning one address never has to decode the other's records. */
function keyGrantAnchorHash(organizationId: string): number[] {
  return Hash.sha256(`${KEY_GRANT_ANCHOR_LABEL}${organizationId}`, 'utf8').slice(0, 20)
}

export function keyGrantAnchorAddress(organizationId: string, network: 'mainnet' | 'testnet' = 'testnet'): string {
  assertTestnetOnly(network.toUpperCase())
  return Utils.toBase58Check(keyGrantAnchorHash(organizationId), TESTNET_PREFIX)
}

/**
 * The address a cadet channel's records are paid to (ADR 013), derived from the channel key itself: whoever holds the key can
 * find the records, the address alone gives nobody the key, and a new key (Replace phone) means a new address the old phone never
 * learns. The label keeps it apart from every unit and key-grant anchor. The key is 32 bytes as 64 hex characters.
 */
export function channelAddress(channelKey: string, network: 'mainnet' | 'testnet' = 'testnet'): string {
  assertTestnetOnly(network.toUpperCase())
  if (typeof channelKey !== 'string' || !/^[0-9a-fA-F]{64}$/.test(channelKey)) throw new Error('A channel key is 32 bytes, written as 64 hex characters.')
  const hash = Hash.sha256([...Utils.toArray(CHANNEL_LABEL, 'utf8'), ...Utils.toArray(channelKey.toLowerCase(), 'hex')]).slice(0, 20)
  return Utils.toBase58Check(hash, TESTNET_PREFIX)
}

export function anchorLockingScript(address: string): LockingScript {
  return new P2PKH().lock(address)
}
