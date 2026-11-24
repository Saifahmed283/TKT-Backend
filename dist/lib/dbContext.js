import { AsyncLocalStorage } from 'node:async_hooks';
const contextStorage = new AsyncLocalStorage();
const txStorage = new AsyncLocalStorage();
export function getDbContext() {
    return contextStorage.getStore() ?? {};
}
export function enterDbContext(context) {
    contextStorage.enterWith({ ...context });
}
export function runWithDbContext(context, fn) {
    return contextStorage.run({ ...context }, fn);
}
/** Runs work after a request has committed, without inheriting its transaction. */
export function runWithIsolatedDbContext(context, fn) {
    return contextStorage.run({ ...context }, () => txStorage.run(undefined, fn));
}
/** Sets transaction-local RLS settings on the given client from the active context. */
export function contextStatement(client) {
    const ctx = getDbContext();
    const eventIds = (ctx.eventIds ?? []).join(',');
    return client.$queryRaw `SELECT
    set_config('app.user_id', ${ctx.userId ?? ''}, true),
    set_config('app.org_id', ${ctx.orgId ?? ''}, true),
    set_config('app.event_id', ${ctx.eventId ?? ''}, true),
    set_config('app.event_ids', ${eventIds}, true),
    set_config('app.is_super_admin', ${ctx.isSuperAdmin ? 'true' : 'false'}, true),
    set_config('app.is_auth', ${ctx.isAuth ? 'true' : 'false'}, true),
    set_config('app.is_public', ${ctx.isPublic ? 'true' : 'false'}, true),
    set_config('app.public_event_id', ${ctx.publicEventId ?? ''}, true),
    set_config('app.contact_id', ${ctx.contactId ?? ''}, true),
    set_config('app.is_internal', ${ctx.isInternal ? 'true' : 'false'}, true)`;
}
export async function updateDbContext(patch) {
    const current = contextStorage.getStore();
    if (!current)
        return;
    const changed = Object.entries(patch).some(([key, value]) => current[key] !== value);
    if (!changed)
        return;
    Object.assign(current, patch);
    const activeTx = txStorage.getStore();
    if (activeTx)
        await contextStatement(activeTx);
}
export function getActiveDbTransaction() {
    return txStorage.getStore();
}
export function runWithDbTransaction(tx, fn) {
    return txStorage.run(tx, fn);
}
//# sourceMappingURL=dbContext.js.map