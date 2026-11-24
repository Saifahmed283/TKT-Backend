import { AsyncLocalStorage } from 'node:async_hooks'

export type DbContext = {
  userId?: string
  orgId?: string
  eventId?: string
  eventIds?: string[]
  isSuperAdmin?: boolean
  isAuth?: boolean
  isPublic?: boolean
  publicEventId?: string
  contactId?: string
  isInternal?: boolean
}

const contextStorage = new AsyncLocalStorage<DbContext>()
const txStorage = new AsyncLocalStorage<any>()

export function getDbContext(): DbContext {
  return contextStorage.getStore() ?? {}
}

export function enterDbContext(context: DbContext): void {
  contextStorage.enterWith({ ...context })
}

export function runWithDbContext<T>(context: DbContext, fn: () => Promise<T>): Promise<T> {
  return contextStorage.run({ ...context }, fn)
}

/** Runs work after a request has committed, without inheriting its transaction. */
export function runWithIsolatedDbContext<T>(context: DbContext, fn: () => Promise<T>): Promise<T> {
  return contextStorage.run({ ...context }, () => txStorage.run(undefined, fn))
}

/** Sets transaction-local RLS settings on the given client from the active context. */
export function contextStatement(client: any) {
  const ctx = getDbContext()
  const eventIds = (ctx.eventIds ?? []).join(',')
  return client.$queryRaw`SELECT
    set_config('app.user_id', ${ctx.userId ?? ''}, true),
    set_config('app.org_id', ${ctx.orgId ?? ''}, true),
    set_config('app.event_id', ${ctx.eventId ?? ''}, true),
    set_config('app.event_ids', ${eventIds}, true),
    set_config('app.is_super_admin', ${ctx.isSuperAdmin ? 'true' : 'false'}, true),
    set_config('app.is_auth', ${ctx.isAuth ? 'true' : 'false'}, true),
    set_config('app.is_public', ${ctx.isPublic ? 'true' : 'false'}, true),
    set_config('app.public_event_id', ${ctx.publicEventId ?? ''}, true),
    set_config('app.contact_id', ${ctx.contactId ?? ''}, true),
    set_config('app.is_internal', ${ctx.isInternal ? 'true' : 'false'}, true)`
}

export async function updateDbContext(patch: Partial<DbContext>): Promise<void> {
  const current = contextStorage.getStore()
  if (!current) return
  const changed = Object.entries(patch).some(([key, value]) => current[key as keyof DbContext] !== value)
  if (!changed) return
  Object.assign(current, patch)
  const activeTx = txStorage.getStore()
  if (activeTx) await contextStatement(activeTx)
}

export function getActiveDbTransaction(): any | undefined {
  return txStorage.getStore()
}

export function runWithDbTransaction<T>(tx: any, fn: () => Promise<T>): Promise<T> {
  return txStorage.run(tx, fn)
}
