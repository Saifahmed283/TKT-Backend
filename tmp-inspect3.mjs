import { PrismaClient } from '@prisma/client'
const p = new PrismaClient()
const rows = await p.event.findMany({select:{name:true,status:true,startAt:true,endAt:true,settings:true,ticketTypes:{select:{name:true,isPublic:true,active:true,salesStartAt:true,salesEndAt:true,quota:true,_count:{select:{tickets:true}}}}}})
console.log(JSON.stringify(rows.map(r=>({...r,startAt:r.startAt,endAt:r.endAt})), null, 2))
await p.$disconnect()
