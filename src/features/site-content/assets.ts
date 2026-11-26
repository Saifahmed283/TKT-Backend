import { config } from '../../config.js'
import { proofPathFromUrl, proofUrl } from '../../lib/uploadStore.js'
import type { SiteContentData } from './schema.js'

function refreshImageUrl(value?: string | null): string | null | undefined {
  if (!value) return value
  const path = proofPathFromUrl(value)
  // Private Blob assets are persisted by path, not by a short-lived capability.
  // Mint a fresh read URL for each API response so team portraits and partner
  // logos remain visible long after the original upload token expires.
  return path ? proofUrl(path, config.uploads.proofTtl) : value
}

export function refreshSiteContentImageUrls(content: SiteContentData): SiteContentData {
  return {
    ...content,
    members: content.members.map((member) => ({
      ...member,
      imageUrl: refreshImageUrl(member.imageUrl),
    })),
    partners: content.partners.map((partner) => ({
      ...partner,
      imageUrl: refreshImageUrl(partner.imageUrl),
    })),
  }
}
