import { afterEach, describe, expect, it, vi } from 'vitest'
import { waitUntil } from '@vercel/functions'

const requestContextKey = Symbol.for('@vercel/request-context')
type RuntimeContext = {
  get?: () => { waitUntil?: (promise: Promise<unknown>) => void }
}
const runtimeHost = globalThis as unknown as Record<symbol, RuntimeContext | undefined>
const previousContext = runtimeHost[requestContextKey]

afterEach(() => {
  if (previousContext === undefined) delete runtimeHost[requestContextKey]
  else runtimeHost[requestContextKey] = previousContext
  vi.restoreAllMocks()
})

describe('Vercel background task lifetime', () => {
  it('registers post-response work with the Vercel request runtime', async () => {
    const work = Promise.resolve('outbox drained')
    const register = vi.fn()
    runtimeHost[requestContextKey] = { get: () => ({ waitUntil: register }) }

    waitUntil(work)

    expect(register).toHaveBeenCalledTimes(1)
    expect(register).toHaveBeenCalledWith(work)
    await expect(work).resolves.toBe('outbox drained')
  })

  it('remains safe when run outside the Vercel request runtime', () => {
    delete runtimeHost[requestContextKey]
    expect(() => waitUntil(Promise.resolve())).not.toThrow()
  })
})
