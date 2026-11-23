import { PrismaClient } from '@prisma/client';
const p=new PrismaClient();
const evs=await p.event.findMany({select:{id:true,name:true,status:true,startAt:true,endAt:true,settings:true}});
console.log(evs.map(e=>({name:e.name,status:e.status,startAt:e.startAt,endAt:e.endAt,reg:e.settings?.registration})));
await p.();
