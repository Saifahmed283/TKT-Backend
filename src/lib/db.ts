import { PrismaClient } from '@prisma/client'
import { contextStatement, getActiveDbTransaction, runWithDbTransaction } from './dbContext.js'

const basePrisma = new PrismaClient({
  log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
})

const modelNames = new Set(
  Object.keys(basePrisma).filter((key) => {
    const value = (basePrisma as any)[key]
    return value && typeof value === 'object' && typeof value.findUnique === 'function' && typeof value.create === 'function'
  }),
)

const rawMethods = new Set([
  '$queryRaw',
  '$executeRaw',
  '$queryRawUnsafe',
  '$executeRawUnsafe',
  '$queryRawTyped',
])

async function runScoped<T>(call: (client: any) => Promise<T>): Promise<T> {
  const activeTx = getActiveDbTransaction()
  if (activeTx) return call(activeTx)

  return basePrisma.$transaction(async (tx) => {
    await contextStatement(tx)
    return runWithDbTransaction(tx, () => call(tx))
  })
}

function transaction(...args: any[]): any {
  const activeTx = getActiveDbTransaction()

  if (Array.isArray(args[0])) {
    const statements = args[0] as any[]
    return (basePrisma.$transaction as any)([contextStatement(basePrisma), ...statements], args[1])
  }

  const callback = args[0]
  const options = args[1]
  if (activeTx) return callback(activeTx, options)

  return (basePrisma.$transaction as any)(async (tx: any) => {
    await contextStatement(tx)
    return runWithDbTransaction(tx, () => callback(tx))
  }, options)
}

function wrapDelegate(model: string, delegate: any): any {
  return new Proxy(delegate, {
    get(target, prop) {
      if (typeof prop !== 'string' || prop.startsWith('$')) return Reflect.get(target, prop)
      const value = Reflect.get(target, prop)
      if (typeof value !== 'function') return value
      return (...args: any[]) => runScoped((client) => (client[model] as any)[prop](...args))
    },
  })
}

/**
 * Prisma client that establishes transaction-local RLS context for every
 * operation. Requests set their context via AsyncLocalStorage; jobs and seeds
 * set `isInternal: true` explicitly.
 */
export const prisma = new Proxy(basePrisma, {
  get(target, prop, receiver) {
    if (prop === '$transaction') return transaction
    if (typeof prop === 'string' && rawMethods.has(prop)) {
      return (...args: any[]) => runScoped((client) => (client as any)[prop](...args))
    }
    const value = Reflect.get(target, prop, receiver)
    if (typeof prop === 'string' && modelNames.has(prop)) return wrapDelegate(prop, value)
    return value
  },
}) as unknown as PrismaClient

/** Lightweight connectivity probe used by the readiness endpoint. */
export async function checkDatabase(): Promise<void> {
  await basePrisma.$queryRaw`SELECT 1`
}
