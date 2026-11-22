import { PrismaClient } from '@prisma/client'
import { BASE_ROLES } from '../src/lib/rbac.js'
import { hashPassword } from '../src/lib/auth.js'
import { credentialCode, type CredentialPayload } from '../src/lib/credentials.js'

const prisma = new PrismaClient()

async function main() {
  console.log('Seeding system roles…')
  for (const role of BASE_ROLES) {
    const existing = await prisma.role.findUnique({ where: { code: role.code } })
    if (existing) {
      await prisma.role.update({
        where: { code: role.code },
        data: { permissions: role.permissions as any, scope: role.scope, name: role.name },
      })
      console.log(`  updated ${role.code}`)
    } else {
      await prisma.role.create({
        data: {
          code: role.code,
          name: role.name,
          description: role.description,
          kind: 'SYSTEM',
          scope: role.scope,
          permissions: role.permissions as any,
          system: true,
        },
      })
      console.log(`  created ${role.code}`)
    }
  }

  const adminEmail = process.env.SEED_ADMIN_EMAIL ?? 'admin@tkt.local'
  const adminPassword = process.env.SEED_ADMIN_PASSWORD ?? 'Admin12345!'

  const existing = await prisma.user.findUnique({ where: { email: adminEmail } })
  if (existing) {
    await prisma.user.update({
      where: { email: adminEmail },
      data: { platformRole: 'super_admin', passwordHash: await hashPassword(adminPassword) },
    })
  } else {
    await prisma.user.create({
      data: {
        name: 'Platform Admin',
        email: adminEmail,
        passwordHash: await hashPassword(adminPassword),
        platformRole: 'super_admin',
      },
    })
  }
  console.log(`Super admin ready: ${adminEmail}`)

  console.log('Seed complete.')
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())