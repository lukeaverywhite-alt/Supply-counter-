import { computeTxid, decodeArgusRecords } from '../chain/codec'
import type { ChainApi } from '../chain/types'
import { deserializeChannelEnvelope, importChannelKey, openFromChannel, type ChannelEnvelope, type ChannelRecordKind } from './envelope'

/** One record read from a channel and opened with its key (ADR 013). */
export type ChannelRecordRead = { txid: string; envelope: ChannelEnvelope; kind: ChannelRecordKind; plaintext: unknown }
const MAX_HISTORY_PAGES = 20

/**
 * Every record at one channel's address that opens under its key, oldest first: kind 'C' records only, sealed to this channel.
 * Fetches that one address and nothing else; anything that does not open (another channel's record, a damaged or altered
 * transaction, a record sealed under an earlier key) is skipped. Who holds the key reads the channel: a cadet's phone its own,
 * staff any cadet's, on demand.
 */
export async function readChannelRecords(api: ChainApi, address: string, channelKey: string): Promise<ChannelRecordRead[]> {
  const key = await importChannelKey(channelKey), txids: string[] = []
  let token: string | undefined, pages = 0
  do { const page = await api.confirmedHistory(address, token ? { token } : {}); txids.push(...page.items.map(item => item.txid)); token = page.nextToken; pages++ } while (token && pages < MAX_HISTORY_PAGES)
  for (const txid of await api.unconfirmedHistory(address)) if (!txids.includes(txid)) txids.push(txid)
  const records: ChannelRecordRead[] = []
  for (const txid of txids) {
    const hex = (await api.txHex(txid)).trim().toLowerCase()
    let payloads: Uint8Array[]
    try { if (computeTxid(hex) !== txid) continue; payloads = decodeArgusRecords(hex).filter(record => record.kind === 'C').map(record => record.payload) } catch { continue }
    for (const payload of payloads) {
      try { const envelope = deserializeChannelEnvelope(payload), { kind, plaintext } = await openFromChannel(envelope, key, address); records.push({ txid, envelope, kind, plaintext }) } catch { /* not this channel's, or damaged */ }
    }
  }
  return records
}
