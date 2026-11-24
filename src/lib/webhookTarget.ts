import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { config } from '../config.js'
import { errors } from './errors.js'

function ipv4ToInt(ip: string): number {
  return ip.split('.').reduce((acc, part) => (acc * 256) + Number(part), 0) >>> 0
}

function inRange(value: number, base: string, bits: number): boolean {
  const start = ipv4ToInt(base)
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0
  return (value & mask) === (start & mask)
}

function isBlockedIpv4(ip: string): boolean {
  const value = ipv4ToInt(ip)
  return (
    inRange(value, '0.0.0.0', 8) ||
    inRange(value, '10.0.0.0', 8) ||
    inRange(value, '100.64.0.0', 10) ||
    inRange(value, '127.0.0.0', 8) ||
    inRange(value, '169.254.0.0', 16) ||
    inRange(value, '172.16.0.0', 12) ||
    inRange(value, '192.0.0.0', 24) ||
    inRange(value, '192.0.2.0', 24) ||
    inRange(value, '192.168.0.0', 16) ||
    inRange(value, '198.18.0.0', 15) ||
    inRange(value, '198.51.100.0', 24) ||
    inRange(value, '203.0.113.0', 24) ||
    inRange(value, '224.0.0.0', 4) ||
    inRange(value, '240.0.0.0', 4)
  )
}

function isBlockedIpv6(ip: string): boolean {
  const value = ip.toLowerCase()
  if (value === '::' || value === '::1') return true
  if (value.startsWith('2001:db8:')) return true
  if (value.startsWith('100::')) return true

  const first = parseInt(value.split(':')[0] || '0', 16)
  if ((first & 0xfe00) === 0xfc00) return true // unique local fc00::/7
  if ((first & 0xffc0) === 0xfe80) return true // link local fe80::/10
  return false
}

function isLoopbackAddress(address: string): boolean {
  const normalized = address.replace(/^\[|\]$/g, '')
  const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i)
  if (mapped) return isLoopbackAddress(mapped[1]!)
  return normalized === '::1' || /^127\./.test(normalized)
}

function isBlockedAddress(address: string): boolean {
  const normalized = address.replace(/^\[|\]$/g, '')
  const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i)
  if (mapped) return isBlockedIpv4(mapped[1]!)
  if (isIP(normalized) === 4) return isBlockedIpv4(normalized)
  if (isIP(normalized) === 6) return isBlockedIpv6(normalized)
  return true
}

export async function assertSafeWebhookUrl(raw: string): Promise<string> {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw errors.badRequest('Invalid webhook URL')
  }

  if (url.username || url.password) throw errors.badRequest('Webhook URL must not include credentials')

  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  const allowLocalWebhook = hostname === 'localhost' && !config.isProd

  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && allowLocalWebhook)) {
    throw errors.badRequest('Webhook URL must use https')
  }
  if (url.port && !allowLocalWebhook) {
    throw errors.badRequest('Webhook URL must use the default port')
  }

  let addresses: Array<{ address: string }>
  try {
    addresses = isIP(hostname) ? [{ address: hostname }] : await lookup(hostname, { all: true })
  } catch {
    throw errors.badRequest('Webhook host could not be resolved')
  }
  if (!addresses.length || addresses.some(({ address }) => {
    if (allowLocalWebhook && isLoopbackAddress(address)) return false
    return isBlockedAddress(address)
  })) {
    throw errors.badRequest('Webhook host is not allowed')
  }

  return url.toString()
}
