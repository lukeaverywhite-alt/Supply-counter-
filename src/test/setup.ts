import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach } from 'vitest'

beforeEach(() => { Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: new IDBFactory() }) })

afterEach(() => {
  cleanup()
  localStorage.clear()
})
