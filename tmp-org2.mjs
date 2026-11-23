import { PrismaClient } from '@prisma/client';
const p=new PrismaClient();
const org=await p.organization.findFirst({include:{members:{include:{user:{select:{email:true,name:true}}}}}});
console.log(JSON.stringify(org,null,2));
await p.$disconnect();
