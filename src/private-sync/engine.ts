import type { ArgusIdentityProvider } from '../identity/identity'
import type { SignedArgusEvent } from '../distributed/types'
import type { ArgusRepository, RepositoryState, RemoteSyncMetadata } from '../storage/repository'
import { decryptEvent, encryptEvent } from './crypto'
import type { KeyDistributionService } from './keys'
import type { PrivateHistoryProvider } from './types'

export type PrivateSyncEngineOptions = {
  providerId: string
  repository: ArgusRepository
  provider: PrivateHistoryProvider
  identity: ArgusIdentityProvider
  keys: KeyDistributionService
  organizationId: string
  /** Must verify event signature, authorization, schema/base versions and project synchronously. */
  validateAndApply: (state: RepositoryState, event: SignedArgusEvent) => void
}

/** Serialized local-first synchronization. Cursor and projection commit atomically. */
export class PrivateSyncEngine {
  private running?: Promise<void>
  constructor(private readonly options: PrivateSyncEngineOptions) {}
  sync() { return this.running ?? (this.running = this.run().finally(() => { this.running = undefined })) }
  private metadata(state: RepositoryState): RemoteSyncMetadata {
    let value = state.remoteSync.find(item => item.providerId === this.options.providerId)
    if (!value) { value = { providerId:this.options.providerId,state:'DISCONNECTED' }; state.remoteSync.push(value) }
    return value
  }
  private async run() {
    const attempted = new Date().toISOString()
    await this.options.repository.transaction(state => { const meta=this.metadata(state);meta.state='SYNCHRONIZING';meta.lastAttemptAt=attempted;meta.lastError=undefined })
    try {
      const snapshot = await this.options.repository.snapshot()
      for (const item of snapshot.outbox) {
        const stored = snapshot.events.find(record => record.event.eventId === item.eventId)
        if (!stored) continue
        await this.options.provider.publish(await encryptEvent(stored.event,this.options.identity,this.options.keys))
        await this.options.repository.transaction(state => { state.outbox=state.outbox.filter(record=>record.eventId!==item.eventId);const event=state.events.find(record=>record.event.eventId===item.eventId);if(event)event.syncStatus='SYNCHRONIZED' })
      }
      let cursor = (await this.options.repository.snapshot()).remoteSync.find(item=>item.providerId===this.options.providerId)?.cursor ?? '0'
      let hasMore=true
      while(hasMore) {
        const page = await this.options.provider.getSince(cursor), accepted: SignedArgusEvent[] = [], rejected: Array<{eventId:string;reason:string}> = []
        for (const raw of page.envelopes) {
          try { const event=await decryptEvent(raw,await this.options.identity.getPublicIdentity(),this.options.identity,this.options.keys);if(event.organizationId!==this.options.organizationId)throw new Error('Wrong organization.');accepted.push(event) }
          catch(error){const id=typeof raw==='object'&&raw&&'eventId'in raw?String(raw.eventId):'unknown';rejected.push({eventId:id,reason:error instanceof Error?error.message:'Invalid remote envelope.'})}
        }
        await this.options.repository.transaction(state => {
          for(const event of accepted)this.options.validateAndApply(state,event)
          for(const invalid of rejected)if(!state.quarantine.some(item=>item.eventId===invalid.eventId&&item.reason===invalid.reason))state.quarantine.push({...invalid,receivedAt:new Date().toISOString()})
          const meta=this.metadata(state);meta.cursor=page.cursor
        })
        cursor=page.cursor
        hasMore=Boolean(page.hasMore)
      }
      await this.options.repository.transaction(state=>{const meta=this.metadata(state);meta.state='SYNCHRONIZED';meta.lastSuccessAt=new Date().toISOString();meta.lastError=undefined})
    } catch(error) {
      await this.options.repository.transaction(state=>{const meta=this.metadata(state);meta.state='FAILED';meta.lastError=error instanceof Error?error.message:'Remote synchronization failed.'})
      throw error
    }
  }
}

export class SyncScheduler {
  private timer?: ReturnType<typeof setInterval>
  private readonly trigger = () => { void this.engine.sync().catch(()=>undefined) }
  constructor(private readonly engine: Pick<PrivateSyncEngine,'sync'>, private readonly intervalMs=10_000) {}
  start() { this.trigger();this.timer=setInterval(this.trigger,this.intervalMs);globalThis.addEventListener?.('online',this.trigger);globalThis.document?.addEventListener('visibilitychange',this.onVisibility) }
  private onVisibility=()=>{if(globalThis.document.visibilityState==='visible')this.trigger()}
  stop(){if(this.timer)clearInterval(this.timer);globalThis.removeEventListener?.('online',this.trigger);globalThis.document?.removeEventListener('visibilitychange',this.onVisibility)}
}
