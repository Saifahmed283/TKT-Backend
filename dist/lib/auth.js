import { SignJWT, jwtVerify } from 'jose';
import bcrypt from 'bcryptjs';
import { config } from '../config.js';
const accessKey = new TextEncoder().encode(config.jwt.accessSecret);
const refreshKey = new TextEncoder().encode(config.jwt.refreshSecret);
export async function hashPassword(password) {
    return bcrypt.hash(password, 12);
}
export async function verifyPassword(password, hash) {
    return bcrypt.compare(password, hash);
}
export async function signAccessToken(user) {
    return new SignJWT({ type: 'access', email: user.email, name: user.name })
        .setProtectedHeader({ alg: 'HS256' })
        .setSubject(user.id)
        .setIssuedAt()
        .setExpirationTime(config.jwt.accessTtl)
        .sign(accessKey);
}
export async function signRefreshToken(userId) {
    return new SignJWT({ type: 'refresh' })
        .setProtectedHeader({ alg: 'HS256' })
        .setSubject(userId)
        .setIssuedAt()
        .setExpirationTime(config.jwt.refreshTtl)
        .sign(refreshKey);
}
export async function verifyAccessToken(token) {
    try {
        const { payload } = await jwtVerify(token, accessKey);
        if (payload.type !== 'access')
            return null;
        return {
            sub: payload.sub,
            email: payload.email ?? '',
            name: payload.name ?? '',
            type: 'access',
        };
    }
    catch {
        return null;
    }
}
export async function verifyRefreshToken(token) {
    try {
        const { payload } = await jwtVerify(token, refreshKey);
        if (payload.type !== 'refresh')
            return null;
        return { sub: payload.sub, type: 'refresh' };
    }
    catch {
        return null;
    }
}
//# sourceMappingURL=auth.js.map