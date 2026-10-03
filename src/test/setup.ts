import '@testing-library/jest-dom/vitest'
import { cleanup, configure } from '@testing-library/react'
import { afterEach, beforeEach, vi } from 'vitest'

// findBy*/waitFor default to 1 s. Signing and key derivation run for real in these tests, and under test:coverage with
// the whole suite in parallel a single awaited command can take longer than that, so wait for the condition, not a clock.
configure({ asyncUtilTimeout: 15_000 })

// The wall clock can step backwards on a dev box (WSL2 time sync moves it back by 1-2 s several times a minute). A
// credential is only valid from its `issuedAt`, so a Master created just before such a step is "not yet authorized" for
// the next second or so and the chain tests fail at random with `Unauthorized: ... is required`. Tests get a clock that
// never runs backwards: while real time is behind it, each reading is 1 ms after the last (so a credential is never revoked in
// the same millisecond it was issued), as a device with a steady clock would see it.
const RealDate = Date
let latest = 0
const steady = () => {
  const real = RealDate.now()
  return (latest = real > latest ? real : latest + 1)
}
const SteadyDate = new Proxy(RealDate, {
  construct: (target, args, newTarget) => Reflect.construct(target, args.length === 0 ? [steady()] : args, newTarget),
  get: (target, property) => (property === 'now' ? steady : Reflect.get(target, property)),
})
const installSteadyClock = () => { if (!vi.isFakeTimers() && globalThis.Date !== SteadyDate) globalThis.Date = SteadyDate }
installSteadyClock()
// vi.useRealTimers() puts the native Date back, so put ours back after any test that faked timers.
beforeEach(installSteadyClock)

afterEach(() => {
  cleanup()
  localStorage.clear()
  installSteadyClock()
})
