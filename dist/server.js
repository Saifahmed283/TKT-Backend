import { buildApp } from './app.js';
import { config } from './config.js';
import { prisma } from './lib/db.js';
import { runWithDbContext } from './lib/dbContext.js';
async function releaseExpiredSeatHolds() {
    return runWithDbContext({ isInternal: true }, async () => {
        const now = new Date();
        const expired = await prisma.busSeat.updateMany({
            where: { state: 'HELD', holdExpiresAt: { lt: now } },
            data: { state: 'AVAILABLE', holderName: null, passengerName: null, passengerEmail: null, passengerPhone: null, groupId: null, ticketId: null, holdToken: null, holdExpiresAt: null, reservedAt: null },
        }).catch(() => ({ count: 0 }));
        return expired.count;
    });
}
async function main() {
    const app = await buildApp();
    const holdTimer = setInterval(() => { void releaseExpiredSeatHolds(); }, 60_000);
    app.addHook('onClose', async () => { clearInterval(holdTimer); });
    try {
        await app.listen({ port: config.port, host: config.host });
        void releaseExpiredSeatHolds();
        console.log(`\n  TKT API listening on http://localhost:${config.port}`);
        console.log(`  Health:  http://localhost:${config.port}/health\n`);
    }
    catch (err) {
        app.log.error(err);
        process.exit(1);
    }
}
main();
//# sourceMappingURL=server.js.map