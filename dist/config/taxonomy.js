// ─────────────────────────────────────────────────────────────
// TKT TAXONOMY — SINGLE SOURCE OF TRUTH
//
// This module deliberately keeps three different dimensions apart:
//   1. Event format  -> Event.type   (Prisma enum, unchanged)
//   2. Event domain  -> settings.taxonomy.domain (JSON only, no migration)
//   3. Event class   -> Event.category (legacy string, kept for compatibility)
//
// It also provides canonical ticket tiers and attendee types matching the
// existing additive Prisma enums, plus SAC legacy aliases. No schema change.
// ─────────────────────────────────────────────────────────────
export const EVENT_FORMAT_CODES = [
    'CONFERENCE',
    'CONCERT',
    'WEDDING',
    'SPORTS',
    'EXHIBITION',
    'CHARITY',
    'CORPORATE',
    'UNIVERSITY',
    'OTHER',
];
export const EVENT_CATEGORY_CODES = [
    'CONFERENCE',
    'EXHIBITION',
    'CONCERT',
    'FESTIVAL',
    'SPORTS',
    'CORPORATE',
    'UNIVERSITY',
    'COMMUNITY',
    'PRIVATE',
    'OTHER',
];
export const EVENT_DOMAIN_CODES = [
    'TECHNOLOGY',
    'EDUCATION',
    'BUSINESS',
    'HEALTHCARE',
    'GOVERNMENT',
    'NON_PROFIT',
    'ARTS_CULTURE',
    'SPORTS',
    'ENTERTAINMENT',
    'COMMUNITY',
    'PRIVATE',
    'OTHER',
];
export const TICKET_TIER_CODES = [
    'STANDARD',
    'VIP',
    'PREMIUM',
    'EARLY_BIRD',
    'STUDENT',
    'COMPLIMENTARY',
    'STAFF',
    'SPEAKER',
    'SPONSOR',
    'OTHER',
];
export const ATTENDEE_TYPE_CODES = [
    'ATTENDEE',
    'VIP',
    'SPEAKER',
    'SPONSOR',
    'EXHIBITOR',
    'MEDIA',
    'STAFF',
    'ORGANIZER',
    'STUDENT',
    'GUEST',
    'OTHER',
];
export const EVENT_FORMATS = [
    {
        code: 'CONFERENCE',
        label: 'Conference',
        description: 'A structured program of talks, panels or workshops.',
        aliases: ['conference', 'educational', 'workshop', 'seminar', 'lecture', 'technology', 'tech_conference', 'ai_summit'],
    },
    {
        code: 'CONCERT',
        label: 'Concert / performance',
        description: 'Live music, comedy or cinema programming.',
        aliases: ['concert', 'music', 'music_concert', 'festival', 'comedy_show', 'cinema_premiere', 'entertainment'],
    },
    {
        code: 'WEDDING',
        label: 'Wedding',
        description: 'Private celebration with a ceremonial program.',
        aliases: ['wedding', 'marriage'],
    },
    {
        code: 'SPORTS',
        label: 'Sports',
        description: 'Competition, tournament or athletic gathering.',
        aliases: ['sports', 'football', 'marathon', 'tournament'],
    },
    {
        code: 'EXHIBITION',
        label: 'Exhibition / Expo',
        description: 'Showcase of exhibits, products, art or fashion.',
        aliases: ['exhibition', 'exhibition_expo', 'expo', 'trade_expo', 'art_exhibition', 'museum_exhibition', 'fashion', 'fashion_show', 'cultural'],
    },
    {
        code: 'CHARITY',
        label: 'Charity',
        description: 'Fundraising or community-support event.',
        aliases: ['charity', 'fundraising', 'charity_gala'],
    },
    {
        code: 'CORPORATE',
        label: 'Corporate',
        description: 'Business summit, networking or company event.',
        aliases: ['corporate', 'business', 'business_corporate', 'summit', 'networking'],
    },
    {
        code: 'UNIVERSITY',
        label: 'University / academic',
        description: 'Academic gathering, thesis defense or research conference.',
        aliases: ['university', 'academic', 'thesis_defense', 'academic_conference'],
    },
    {
        code: 'OTHER',
        label: 'Other',
        description: 'Format not yet classified. Use the event domain for detail.',
        aliases: ['other', 'protocol', 'protocol_official', 'official', 'government', 'government_official', 'military', 'military_officer', 'adventure', 'community', 'unknown', 'unknown_type'],
    },
];
export const EVENT_CATEGORIES = [
    {
        code: 'CONFERENCE',
        label: 'Conference class',
        description: 'Legacy class for conference-style programs.',
        aliases: ['conference', 'educational', 'workshop', 'seminar', 'lecture', 'tech_conference', 'ai_summit'],
    },
    {
        code: 'EXHIBITION',
        label: 'Exhibition class',
        description: 'Legacy class for showcases and exhibitions.',
        aliases: ['exhibition', 'exhibition_expo', 'expo', 'trade_expo', 'art_exhibition', 'museum_exhibition', 'fashion', 'fashion_show'],
    },
    {
        code: 'CONCERT',
        label: 'Concert class',
        description: 'Legacy class for music and stage performances.',
        aliases: ['concert', 'music', 'music_concert', 'comedy_show', 'cinema_premiere'],
    },
    {
        code: 'FESTIVAL',
        label: 'Festival class',
        description: 'Legacy class for multi-program festivals.',
        aliases: ['festival', 'music_festival', 'cultural_festival', 'entertainment_festival'],
    },
    {
        code: 'SPORTS',
        label: 'Sports class',
        description: 'Legacy class for sport and competition.',
        aliases: ['sports', 'football', 'marathon', 'tournament'],
    },
    {
        code: 'CORPORATE',
        label: 'Corporate class',
        description: 'Legacy class for business and corporate events.',
        aliases: ['corporate', 'business', 'business_corporate', 'summit', 'networking'],
    },
    {
        code: 'UNIVERSITY',
        label: 'University class',
        description: 'Legacy class for academic and university events.',
        aliases: ['university', 'academic', 'thesis_defense', 'academic_conference'],
    },
    {
        code: 'COMMUNITY',
        label: 'Community class',
        description: 'Legacy class for local and social gatherings.',
        aliases: ['community', 'local_gathering', 'social_event', 'adventure', 'hiking_event', 'desert_safari'],
    },
    {
        code: 'PRIVATE',
        label: 'Private class',
        description: 'Legacy class for closed or invite-only events.',
        aliases: ['private', 'wedding', 'closed_event'],
    },
    {
        code: 'OTHER',
        label: 'Other class',
        description: 'Legacy fallback for values not yet classified.',
        aliases: ['other', 'protocol', 'protocol_official', 'official', 'government', 'government_official', 'military', 'defense_conference', 'parade', 'unknown', 'unknown_type'],
    },
];
export const EVENT_DOMAINS = [
    {
        code: 'TECHNOLOGY',
        label: 'Technology',
        description: 'Tech conferences, hackathons and product launches.',
        aliases: ['technology', 'tech', 'tech_conference', 'hackathon', 'ai_summit', 'developer'],
    },
    {
        code: 'EDUCATION',
        label: 'Education',
        description: 'Learning, schools, universities and research.',
        aliases: ['education', 'educational', 'academic', 'university', 'workshop', 'seminar', 'lecture'],
    },
    {
        code: 'BUSINESS',
        label: 'Business',
        description: 'Corporate, finance, startup and professional activity.',
        aliases: ['business', 'corporate', 'business_corporate', 'summit', 'networking', 'startup', 'investor'],
    },
    {
        code: 'HEALTHCARE',
        label: 'Healthcare',
        description: 'Medical, clinical and public-health events.',
        aliases: ['healthcare', 'health', 'medical', 'hospital', 'clinic'],
    },
    {
        code: 'GOVERNMENT',
        label: 'Government / official',
        description: 'Protocol, diplomatic, military and public-sector events.',
        aliases: ['government', 'protocol', 'protocol_official', 'official', 'military', 'defense', 'diplomatic', 'government_official'],
    },
    {
        code: 'NON_PROFIT',
        label: 'Non-profit',
        description: 'Charity, fundraising and community-support events.',
        aliases: ['non_profit', 'nonprofit', 'charity', 'fundraising', 'donation'],
    },
    {
        code: 'ARTS_CULTURE',
        label: 'Arts & culture',
        description: 'Museums, exhibitions, fashion and cultural programs.',
        aliases: ['arts_culture', 'culture', 'cultural', 'arts', 'art', 'museum', 'exhibition', 'expo', 'fashion'],
    },
    {
        code: 'SPORTS',
        label: 'Sports',
        description: 'Sporting competitions and athletics.',
        aliases: ['sports', 'football', 'marathon', 'tournament', 'athletics'],
    },
    {
        code: 'ENTERTAINMENT',
        label: 'Entertainment',
        description: 'Music, concerts, festivals, comedy and cinema.',
        aliases: ['entertainment', 'music', 'concert', 'festival', 'comedy', 'cinema', 'celebrity'],
    },
    {
        code: 'COMMUNITY',
        label: 'Community',
        description: 'Local gatherings, social events and outdoor activities.',
        aliases: ['community', 'local', 'social', 'adventure', 'hiking', 'desert_safari'],
    },
    {
        code: 'PRIVATE',
        label: 'Private',
        description: 'Closed or invite-only celebrations.',
        aliases: ['private', 'wedding', 'closed'],
    },
    {
        code: 'OTHER',
        label: 'Other',
        description: 'Domain not classified yet.',
        aliases: ['other', 'unknown', 'unspecified'],
    },
];
export const TICKET_TIERS = [
    {
        code: 'STANDARD',
        label: 'Standard',
        description: 'Regular admission.',
        aliases: ['standard', 'general', 'general_admission', 'regular', 'normal', 'ga'],
    },
    {
        code: 'VIP',
        label: 'VIP',
        description: 'Premium access with dedicated privileges.',
        aliases: ['vip', 'vip_ticket', 'vip_guest', 'celebrity', 'elite'],
    },
    {
        code: 'PREMIUM',
        label: 'Premium',
        description: 'Upgraded tier below top VIP access.',
        aliases: ['premium', 'gold', 'platinum', 'diamond', 'golden'],
    },
    {
        code: 'EARLY_BIRD',
        label: 'Early bird',
        description: 'Discounted advance-purchase tier.',
        aliases: ['early_bird', 'earlybird', 'early'],
    },
    {
        code: 'STUDENT',
        label: 'Student',
        description: 'Student-priced admission.',
        aliases: ['student', 'student_ticket', 'academic_rate'],
    },
    {
        code: 'COMPLIMENTARY',
        label: 'Complimentary',
        description: 'Free or invited admission with no payment.',
        aliases: ['complimentary', 'comp', 'free', 'free_ticket', 'invite', 'invitation'],
    },
    {
        code: 'STAFF',
        label: 'Staff',
        description: 'Operational staff allocation.',
        aliases: ['staff', 'crew', 'worker'],
    },
    {
        code: 'SPEAKER',
        label: 'Speaker',
        description: 'Program participant allocation.',
        aliases: ['speaker', 'keynote', 'keynote_speaker'],
    },
    {
        code: 'SPONSOR',
        label: 'Sponsor',
        description: 'Sponsor allocation.',
        aliases: ['sponsor', 'partner'],
    },
    {
        code: 'OTHER',
        label: 'Other',
        description: 'Tier not classified yet.',
        aliases: ['other', 'unknown', 'unspecified'],
    },
];
export const ATTENDEE_TYPES = [
    {
        code: 'ATTENDEE',
        label: 'Attendee',
        description: 'General participant without a special access class.',
        aliases: ['attendee', 'regular', 'member', 'regular_attendee', 'participant', 'adventurer', 'developer', 'engineer', 'entrepreneur', 'startup_founder', 'academic_member'],
    },
    {
        code: 'VIP',
        label: 'VIP',
        description: 'High-priority guest with enhanced access.',
        aliases: ['vip', 'vip_guest', 'vip_ticket', 'premium', 'diamond', 'platinum', 'gold', 'elite', 'celebrity', 'buyer', 'investor', 'ceo'],
    },
    {
        code: 'SPEAKER',
        label: 'Speaker / program participant',
        description: 'On-stage or program contributor, including performers and creatives.',
        aliases: ['speaker', 'keynote_speaker', 'professor', 'researcher', 'cultural_expert', 'moderator', 'artist', 'performer', 'designer', 'model'],
    },
    {
        code: 'SPONSOR',
        label: 'Sponsor / partner',
        description: 'Commercial partner or sponsor representative.',
        aliases: ['sponsor', 'partner', 'brand', 'marketer'],
    },
    {
        code: 'EXHIBITOR',
        label: 'Exhibitor',
        description: 'Booth or showcase representative.',
        aliases: ['exhibitor', 'exhibitors'],
    },
    {
        code: 'MEDIA',
        label: 'Media',
        description: 'Press, broadcast and credentialed content creators.',
        aliases: ['media', 'press', 'influencer'],
    },
    {
        code: 'STAFF',
        label: 'Staff',
        description: 'Operational, safety, technical or event support role.',
        aliases: ['staff', 'security', 'safety_team', 'technician', 'team_staff', 'volunteer', 'guide', 'soldier', 'military_officer', 'commander', 'follow_up', 'followup', 'follow-up', 'follow up'],
    },
    {
        code: 'ORGANIZER',
        label: 'Organizer',
        description: 'Event owner or organizing committee member.',
        aliases: ['organizer', 'organisers', 'organizers'],
    },
    {
        code: 'STUDENT',
        label: 'Student',
        description: 'Registered student attendee.',
        aliases: ['student', 'scholar'],
    },
    {
        code: 'GUEST',
        label: 'Guest',
        description: 'Invited guest, official delegate or spectator.',
        aliases: ['guest', 'visitor', 'fan', 'regular_fan', 'protocol_official', 'minister', 'diplomat', 'government_official', 'donor', 'referee', 'player', 'athlete', 'coach'],
    },
    {
        code: 'OTHER',
        label: 'Other',
        description: 'Attendee class not yet mapped.',
        aliases: ['other', 'unknown', 'unknown_type', 'unspecified'],
    },
];
const BASELINE_ATTENDEE_TYPES = [
    'ATTENDEE',
    'VIP',
    'SPEAKER',
    'SPONSOR',
    'MEDIA',
    'STAFF',
    'ORGANIZER',
    'GUEST',
];
const FORMAT_ATTENDEE_TYPES = {
    CONFERENCE: [...BASELINE_ATTENDEE_TYPES, 'STUDENT'],
    CONCERT: ['ATTENDEE', 'VIP', 'SPEAKER', 'SPONSOR', 'MEDIA', 'STAFF', 'ORGANIZER', 'GUEST'],
    WEDDING: ['ATTENDEE', 'VIP', 'STAFF', 'ORGANIZER', 'GUEST'],
    SPORTS: ['ATTENDEE', 'VIP', 'SPEAKER', 'SPONSOR', 'MEDIA', 'STAFF', 'ORGANIZER', 'GUEST'],
    EXHIBITION: ['ATTENDEE', 'VIP', 'SPEAKER', 'SPONSOR', 'EXHIBITOR', 'MEDIA', 'STAFF', 'ORGANIZER', 'GUEST'],
    CHARITY: [...BASELINE_ATTENDEE_TYPES, 'STUDENT'],
    CORPORATE: ['ATTENDEE', 'VIP', 'SPEAKER', 'SPONSOR', 'STAFF', 'ORGANIZER', 'GUEST'],
    UNIVERSITY: [...BASELINE_ATTENDEE_TYPES, 'STUDENT'],
    OTHER: [...ATTENDEE_TYPE_CODES],
};
/**
 * SAC normalizes spaces, hyphens and slashes to underscores. TKT keeps that
 * behavior and also collapses punctuation so values like "Business / Corporate"
 * and "business-corporate" resolve identically.
 */
export function normalizeToken(value) {
    return String(value ?? '')
        .trim()
        .toLowerCase()
        .replace(/[’']/g, '')
        .replace(/&/g, ' and ')
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '');
}
function buildIndex(definitions) {
    const index = new Map();
    for (const definition of definitions) {
        const keys = [definition.code, definition.label, ...(definition.aliases ?? [])];
        for (const key of keys) {
            const normalized = normalizeToken(key);
            if (!normalized)
                continue;
            const existing = index.get(normalized);
            if (existing && existing.code !== definition.code) {
                throw new Error(`Taxonomy alias collision: "${key}" maps to both ${existing.code} and ${definition.code}`);
            }
            index.set(normalized, definition);
        }
    }
    return index;
}
const eventFormatIndex = buildIndex(EVENT_FORMATS);
const eventCategoryIndex = buildIndex(EVENT_CATEGORIES);
const eventDomainIndex = buildIndex(EVENT_DOMAINS);
const ticketTierIndex = buildIndex(TICKET_TIERS);
const attendeeTypeIndex = buildIndex(ATTENDEE_TYPES);
function resolve(index, value) {
    const key = normalizeToken(value);
    return key ? index.get(key) ?? null : null;
}
export const resolveEventFormat = (value) => resolve(eventFormatIndex, value);
export const resolveEventCategory = (value) => resolve(eventCategoryIndex, value);
export const resolveEventDomain = (value) => resolve(eventDomainIndex, value);
export const resolveTicketTier = (value) => resolve(ticketTierIndex, value);
export const resolveAttendeeType = (value) => resolve(attendeeTypeIndex, value);
/** Event format is authoritative; legacy category/domain are supporting signals only. */
export function allowedAttendeeTypes(eventFormat, eventCategory) {
    const format = resolveEventFormat(eventFormat);
    if (format)
        return [...new Set(FORMAT_ATTENDEE_TYPES[format.code])];
    const category = resolveEventCategory(eventCategory);
    if (category) {
        const relatedFormat = resolveEventFormat(category.code);
        if (relatedFormat)
            return [...new Set(FORMAT_ATTENDEE_TYPES[relatedFormat.code])];
    }
    return [...ATTENDEE_TYPE_CODES];
}
function snapshotOf(definitions) {
    return definitions.map(({ code, label, description, aliases }) => ({
        code,
        label,
        description,
        aliases: [...(aliases ?? [])],
    }));
}
/** Immutable-per-call payload for the public metadata endpoint. */
export function taxonomySnapshot() {
    return {
        eventFormats: snapshotOf(EVENT_FORMATS),
        eventCategories: snapshotOf(EVENT_CATEGORIES),
        eventDomains: snapshotOf(EVENT_DOMAINS),
        ticketTiers: snapshotOf(TICKET_TIERS),
        attendeeTypes: snapshotOf(ATTENDEE_TYPES),
    };
}
//# sourceMappingURL=taxonomy.js.map