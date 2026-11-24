import { z } from 'zod';
import { prisma } from '../../lib/db.js';
import { hashPassword, verifyPassword, signAccessToken, signRefreshToken, verifyRefreshToken } from '../../lib/auth.js';
import { errors } from '../../lib/errors.js';
import { authenticate } from '../../middleware/auth.js';
import { writeAudit } from '../../lib/audit.js';
import { config } from '../../config.js';
import { validatePasswordStrength } from '../../lib/passwordPolicy.js';
import { updateDbContext } from '../../lib/dbContext.js';
const registerSchema = z
    .object({
    name: z.string().min(2, 'Name must be at least 2 characters'),
    email: z.string().email(),
    password: z.string().min(1, 'Password is required'),
})
    .superRefine((val, ctx) => {
    const policy = validatePasswordStrength(val.password);
    if (!policy.ok) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['password'], message: policy.reason });
    }
});
const loginSchema = z.object({
    email: z.string().email(),
    password: z.string().min(1),
});
function setRefreshCookie(reply, token) {
    reply.setCookie('tkt_refresh', token, {
        httpOnly: true,
        sameSite: 'lax',
        secure: config.isProd,
        path: '/',
        maxAge: 60 * 60 * 24 * 7,
    });
}
export async function authRoutes(app) {
    app.post('/register', {
        config: { rateLimit: { max: 3, timeWindow: '10 minutes' } },
    }, async (req, reply) => {
        const { name, email, password } = registerSchema.parse(req.body);
        const exists = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
        if (exists)
            throw errors.conflict('An account with this email already exists');
        const user = await prisma.user.create({
            data: {
                name,
                email: email.toLowerCase(),
                passwordHash: await hashPassword(password),
            },
        });
        await updateDbContext({ userId: user.id, isAuth: true });
        const access = await signAccessToken(user);
        const refresh = await signRefreshToken(user.id);
        setRefreshCookie(reply, refresh);
        await writeAudit({
            actorUserId: user.id,
            action: 'user.registered',
            resourceType: 'user',
            resourceId: user.id,
            sourceIp: req.ip,
        });
        return reply.status(201).send({ data: { token: access, user: publicUser(user) } });
    });
    app.post('/login', {
        config: { rateLimit: { max: 5, timeWindow: '5 minutes' } },
    }, async (req, reply) => {
        const { email, password } = loginSchema.parse(req.body);
        const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
        if (!user || !(await verifyPassword(password, user.passwordHash))) {
            throw errors.unauthorized('Invalid email or password');
        }
        if (user.status !== 'ACTIVE')
            throw errors.unauthorized('This account is suspended');
        await updateDbContext({ userId: user.id, isAuth: true });
        await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
        const access = await signAccessToken(user);
        const refresh = await signRefreshToken(user.id);
        setRefreshCookie(reply, refresh);
        await writeAudit({
            actorUserId: user.id,
            action: 'user.login',
            resourceType: 'user',
            resourceId: user.id,
            sourceIp: req.ip,
        });
        return reply.send({ data: { token: access, user: publicUser(user) } });
    });
    app.post('/refresh', {
        config: { rateLimit: { max: 12, timeWindow: '1 minute' } },
    }, async (req, reply) => {
        try {
            const token = req.cookies?.tkt_refresh;
            if (!token)
                throw errors.unauthorized('No refresh session');
            const claims = await verifyRefreshToken(token);
            if (!claims)
                throw errors.unauthorized('Refresh session expired');
            const user = await prisma.user.findUnique({ where: { id: claims.sub } });
            if (!user || user.status !== 'ACTIVE') {
                reply.clearCookie('tkt_refresh', { path: '/' });
                throw errors.unauthorized('Account not found');
            }
            const access = await signAccessToken(user);
            const refresh = await signRefreshToken(user.id);
            setRefreshCookie(reply, refresh);
            return reply.send({ data: { token: access, user: publicUser(user) } });
        }
        catch (err) {
            if (err && typeof err === 'object' && 'statusCode' in err)
                throw err;
            req.log.error({ err }, 'auth.refresh failed');
            throw errors.unauthorized('Refresh session invalid');
        }
    });
    app.post('/logout', async (req, reply) => {
        reply.clearCookie('tkt_refresh', { path: '/' });
        return reply.send({ data: { ok: true } });
    });
    app.get('/me', { preHandler: authenticate }, async (req) => {
        const user = await prisma.user.findUnique({
            where: { id: req.user.id },
            select: {
                id: true, name: true, email: true, phone: true, platformRole: true,
                orgMemberships: {
                    select: {
                        role: true, status: true,
                        org: { select: { id: true, name: true, slug: true } },
                    },
                },
                eventMemberships: {
                    where: { status: 'ACTIVE' },
                    select: {
                        id: true, status: true,
                        role: { select: { code: true, name: true, scope: true, permissions: true } },
                        team: { select: { id: true, name: true } },
                        areas: { select: { area: { select: { id: true, name: true, type: true } } } },
                        event: { select: { id: true, name: true, status: true, type: true, startAt: true, org: { select: { id: true, name: true } } } },
                    },
                    orderBy: { createdAt: 'desc' },
                },
            },
        });
        if (!user)
            throw errors.notFound('User not found');
        return { data: user };
    });
}
function publicUser(user) {
    return { id: user.id, name: user.name, email: user.email, platformRole: user.platformRole };
}
//# sourceMappingURL=routes.js.map