import { PrismaClient } from '@prisma/client';
import { contextStatement, getActiveDbTransaction, runWithDbTransaction } from './dbContext.js';
const basePrisma = new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
});
const modelNames = new Set(Object.keys(basePrisma).filter((key) => {
    const value = basePrisma[key];
    return value && typeof value === 'object' && typeof value.findUnique === 'function' && typeof value.create === 'function';
}));
const rawMethods = new Set([
    '$queryRaw',
    '$executeRaw',
    '$queryRawUnsafe',
    '$executeRawUnsafe',
    '$queryRawTyped',
]);
async function runScoped(call) {
    const activeTx = getActiveDbTransaction();
    if (activeTx)
        return call(activeTx);
    return basePrisma.$transaction(async (tx) => {
        await contextStatement(tx);
        return runWithDbTransaction(tx, () => call(tx));
    });
}
function transaction(...args) {
    const activeTx = getActiveDbTransaction();
    if (Array.isArray(args[0])) {
        const statements = args[0];
        return basePrisma.$transaction([contextStatement(basePrisma), ...statements], args[1]);
    }
    const callback = args[0];
    const options = args[1];
    if (activeTx)
        return callback(activeTx, options);
    return basePrisma.$transaction(async (tx) => {
        await contextStatement(tx);
        return runWithDbTransaction(tx, () => callback(tx));
    }, options);
}
function wrapDelegate(model, delegate) {
    return new Proxy(delegate, {
        get(target, prop) {
            if (typeof prop !== 'string' || prop.startsWith('$'))
                return Reflect.get(target, prop);
            const value = Reflect.get(target, prop);
            if (typeof value !== 'function')
                return value;
            return (...args) => runScoped((client) => client[model][prop](...args));
        },
    });
}
/**
 * Prisma client that establishes transaction-local RLS context for every
 * operation. Requests set their context via AsyncLocalStorage; jobs and seeds
 * set `isInternal: true` explicitly.
 */
export const prisma = new Proxy(basePrisma, {
    get(target, prop, receiver) {
        if (prop === '$transaction')
            return transaction;
        if (typeof prop === 'string' && rawMethods.has(prop)) {
            return (...args) => runScoped((client) => client[prop](...args));
        }
        const value = Reflect.get(target, prop, receiver);
        if (typeof prop === 'string' && modelNames.has(prop))
            return wrapDelegate(prop, value);
        return value;
    },
});
//# sourceMappingURL=db.js.map