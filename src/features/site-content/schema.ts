import { z } from 'zod'

const localizedText = (max: number, required = true) => {
  const value = z.string().trim().max(max)
  return z.object({
    en: required ? value.min(1, 'English text is required') : value,
    ar: required ? value.min(1, 'Arabic text is required') : value,
  })
}

const id = z.string().trim().min(1).max(80)

const imageUrl = z.string().trim().max(2048).refine(
  (value) => value.startsWith('/uploads/')
    || value.startsWith('/api/uploads/blob/')
    || ((value.startsWith('https://') || value.startsWith('http://')) && z.string().url().safeParse(value).success),
  'Image must be an uploaded TKT asset or an HTTP(S) URL',
).nullable().optional()

const memberSchema = z.object({
  id,
  name: localizedText(120),
  role: localizedText(120),
  bio: localizedText(1200),
  imageUrl,
})

const partnerSchema = z.object({
  id,
  name: localizedText(120),
  imageUrl,
})

const reportSchema = z.object({
  id,
  author: localizedText(120),
  role: localizedText(120, false),
  content: localizedText(2000),
  eventName: localizedText(160, false),
})

const uniqueIds = <T extends { id: string }>(items: T[]) => new Set(items.map((item) => item.id)).size === items.length

export const siteContentSchema = z.object({
  copy: z.object({
    team: z.object({
      eyebrow: localizedText(120),
      titleA: localizedText(160),
      titleB: localizedText(160),
      badge: localizedText(120),
    }),
    partners: z.object({
      eyebrow: localizedText(120),
      titleA: localizedText(160),
      titleB: localizedText(160),
    }),
    reports: z.object({
      eyebrow: localizedText(120),
      titleA: localizedText(160),
      titleB: localizedText(160),
    }),
  }),
  members: z.array(memberSchema).max(20).refine(uniqueIds, 'Member IDs must be unique'),
  partners: z.array(partnerSchema).max(60).refine(uniqueIds, 'Partner IDs must be unique'),
  reports: z.array(reportSchema).max(60).refine(uniqueIds, 'Report IDs must be unique'),
})

export type SiteContentData = z.infer<typeof siteContentSchema>

export const ABOUT_SITE_CONTENT_KEY = 'about'

export const DEFAULT_ABOUT_CONTENT: SiteContentData = {
  copy: {
    team: {
      eyebrow: { en: 'The Team', ar: 'الفريق' },
      titleA: { en: 'The people behind ', ar: 'الأشخاص خلف ' },
      titleB: { en: 'the experience', ar: 'TKT' },
      badge: { en: 'Built with intention', ar: 'صُنعت بشغف ودقة' },
    },
    partners: {
      eyebrow: { en: 'Our Partners', ar: 'شركاؤنا' },
      titleA: { en: 'Trusted by the teams', ar: 'موثوق من الفرق' },
      titleB: { en: 'who build the night.', ar: 'التي تصنع الليلة.' },
    },
    reports: {
      eyebrow: { en: 'Field Reports', ar: 'آراء من الميدان' },
      titleA: { en: 'Voices from', ar: 'أصوات من' },
      titleB: { en: 'the floor.', ar: 'قلب الحدث.' },
    },
  },
  members: [
    {
      id: 'team-founder',
      name: { en: 'Founder Name', ar: 'اسم المؤسس' },
      role: { en: 'Founder & CEO', ar: 'المؤسس والرئيس التنفيذي' },
      bio: {
        en: 'Leads the vision behind TKT, shaping premium experiences from concept to unforgettable entry.',
        ar: 'يقود رؤية TKT ويصنع تجارب استثنائية من الفكرة حتى لحظة الدخول.',
      },
    },
    {
      id: 'team-operations',
      name: { en: 'Team Member', ar: 'اسم عضو الفريق' },
      role: { en: 'Operations Lead', ar: 'قائد العمليات' },
      bio: {
        en: 'Builds the systems and on-ground flow that keep every event smooth, secure, and precise.',
        ar: 'يبني الأنظمة وسير العمل الميداني ليبقى كل حدث سلساً وآمناً ودقيقاً.',
      },
    },
    {
      id: 'team-experience',
      name: { en: 'Team Member', ar: 'اسم عضو الفريق' },
      role: { en: 'Experience Designer', ar: 'مصمم التجربة' },
      bio: {
        en: 'Crafts the visual and human details that make every TKT moment feel intentional.',
        ar: 'يصمم التفاصيل البصرية والإنسانية التي تجعل كل لحظة في TKT مدروسة ومميزة.',
      },
    },
  ],
  partners: ['NOVA EVENTS', 'SIGNALWORKS', 'MERIDIAN STAGES', 'AXIS MEDIA', 'HALCYON PROD', 'ORBITAL SOUND'].map((name, index) => ({
    id: `partner-${index + 1}`,
    name: { en: name, ar: name },
  })),
  reports: [],
}
