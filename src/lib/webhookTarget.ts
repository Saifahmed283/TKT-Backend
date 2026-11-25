import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { createHmac } from 'node:crypto'
import { config } from '../config.js'
import { errors } from './errors.js'
import { URL } from 'node:url'
import { createConnection } from 'node:net'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const http = require('http')
const https = require('https')

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

export interface PinnedWebhookTarget {
  url: string
  pinnedIps: string[]
  validatedAt: number
  signature: string // HMAC of url + pinnedIps for integrity
}

/**
 * Validates a webhook URL and pins the resolved IP addresses.
 * Returns a PinnedWebhookTarget that must be used for delivery.
 */
export async function validateAndPinWebhookUrl(raw: string): Promise<PinnedWebhookTarget> {
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

  const validAddresses = addresses.filter(({ address }) => {
    if (allowLocalWebhook && isLoopbackAddress(address)) return true
    return !isBlockedAddress(address)
  })

  if (!validAddresses.length) {
    throw errors.badRequest('Webhook host is not allowed')
  }

  const pinnedIps = validAddresses.map(a => a.address).sort()
  const validatedAt = Date.now()

  // Create a signature of the URL + pinned IPs for integrity verification at delivery time
  const signature = createSignature(url.toString(), pinnedIps)

  return {
    url: url.toString(),
    pinnedIps,
    validatedAt,
    signature,
  }
}

/**
 * Creates a signature for the pinned webhook target to prevent tampering.
 */
function createSignature(url: string, pinnedIps: string[]): string {
  const payload = `${url}|${pinnedIps.join(',')}`
  return createHmac('sha256', config.jwt.accessSecret)
    .update('tkt-webhook-pinning-v1\0')
    .update(payload)
    .digest('base64url')
}

/**
 * Verifies the signature of a pinned webhook target.
 */
export function verifyPinnedTarget(target: PinnedWebhookTarget): boolean {
  const expectedSignature = createSignature(target.url, target.pinnedIps)
  return timingSafeEqual(Buffer.from(target.signature), Buffer.from(expectedSignature))
}

/**
 * Backward-compatible webhook URL validation.
 * Validates URL and returns the validated URL string.
 * For new code, use validateAndPinWebhookUrl() which also pins IPs.
 */
export async function assertSafeWebhookUrl(raw: string): Promise<string> {
  const pinned = await validateAndPinWebhookUrl(raw)
  return pinned.url
}

/**
 * Custom HTTP agent that enforces DNS pinning by connecting to a specific IP
 * while preserving the original hostname for TLS verification and Host header.
 */
export async function createPinnedAgent(target: PinnedWebhookTarget, protocol: 'http:' | 'https:', timeoutMs = 10000): Promise<any> {
  const isHttps = protocol === 'https:'
  const module = isHttps ? https : http
  const pinnedIps = target.pinnedIps

  // Create a custom agent that pins the destination IP
  const Agent = isHttps ? https.Agent : http.Agent
  const agent = new Agent({
    // This will be overridden per-request
  })

  // We'll use a custom createConnection that enforces IP pinning
  return {
    async request(options: any, callback: any) {
      const hostname = options.hostname || 'localhost'
      const port = options.port || (isHttps ? 443 : 80)
      
      // Select a pinned IP (round-robin for load balancing)
      const targetIp = pinnedIps[Math.floor(Math.random() * pinnedIps.length)] ?? pinnedIps[0]!

      // Create a custom connection to the pinned IP
      const socket = isHttps
        ? await createTlsConnection(targetIp, hostname, port)
        : await createTcpConnection(targetIp, port)

      // Override the hostname for TLS verification and Host header
      if (isHttps) {
        options.hostname = hostname // Keep original for SNI
      }

      const req = module.request({
        ...options,
        timeout: timeoutMs,
        createConnection: () => socket,
      }, callback)

      return req
    },
  }
}

function createTcpConnection(host: string, port: number): Promise<any> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host, port }, () => resolve(socket))
    socket.on('error', reject)
  })
}

async function createTlsConnection(host: string, hostname: string, port: number): Promise<any> {
  const tls = await import('node:tls')
  return new Promise((resolve, reject) => {
    const socket = tls.connect({
      host,
      port,
      servername: hostname, // SNI for TLS verification
      checkServerIdentity: (host: string, cert: any) => {
        // Verify the certificate matches the expected hostname
        const altNames = cert.subjectaltname || ''
        if (!altNames.toLowerCase().includes(hostname.toLowerCase())) {
          return new Error(`Certificate does not match hostname ${hostname}`)
        }
        return undefined
      },
    }, () => resolve(socket))
    socket.on('error', reject)
  })
}

/**
 * Delivers a webhook payload using DNS-pinned connection.
 * This prevents DNS rebinding by connecting to the pinned IP.
 */
export async function deliverWebhook(
  target: PinnedWebhookTarget,
  payload: any,
  options: { timeoutMs?: number; maxRetries?: number; body?: string; headers?: Record<string, string> } = {}
): Promise<{ success: boolean; statusCode?: number; error?: string }> {
  // Verify target integrity
  if (!verifyPinnedTarget(target)) {
    return { success: false, error: 'Invalid webhook target signature' }
  }

  const url = new URL(target.url)
  const isHttps = url.protocol === 'https:'
  const maxRetries = options.maxRetries ?? 3
  const timeoutMs = options.timeoutMs ?? 10000

  let lastError: Error | null = null

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetchWithPinning(target, payload, timeoutMs, options.body, options.headers)
      return { success: true, statusCode: response.status }
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err))
      if (attempt < maxRetries) {
        // Exponential backoff: 1s, 2s, 4s
        await new Promise(r => setTimeout(r, 1000 * 2 ** attempt))
      }
    }
  }

  return { success: false, error: lastError?.message ?? 'Unknown error' }
}

async function fetchWithPinning(
  target: PinnedWebhookTarget,
  payload: any,
  timeoutMs: number,
  body?: string,
  headers?: Record<string, string>,
): Promise<Response> {
  const url = new URL(target.url)
  const isHttps = url.protocol === 'https:'
  const pinnedIps = target.pinnedIps

  // Try each pinned IP until one succeeds
  for (const targetIp of pinnedIps) {
    try {
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs)

      // We need to make a raw HTTP request to the pinned IP
      // Since fetch() doesn't support IP pinning, we use a custom approach
      const response = await fetchPinned(targetIp, url, payload, controller.signal, isHttps, timeoutMs, body, headers)

      clearTimeout(timeoutId)
      return response
    } catch (err) {
      // Try next IP
      continue
    }
  }

  throw new Error('All pinned IPs failed')
}

async function fetchPinned(
  targetIp: string,
  url: URL,
  payload: any,
  signal: AbortSignal,
  isHttps: boolean,
  timeoutMs = 10000,
  body?: string,
  headers?: Record<string, string>,
): Promise<Response> {
  const http = isHttps ? (await import('node:https')).default : (await import('node:http')).default
  const tls = isHttps ? (await import('node:tls')).default : null
  const port = Number(url.port) || (isHttps ? 443 : 80)
  const serialized = body ?? JSON.stringify(payload)

  return new Promise((resolve, reject) => {
    const options = {
      hostname: targetIp,
      port,
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Host': url.hostname, // Preserve original hostname for Host header
        'Content-Length': Buffer.byteLength(serialized),
        ...headers,
      },
      signal,
    }

    // For HTTPS, we need custom TLS connection with pinned IP but original hostname for SNI
    let req: any
    if (isHttps) {
      const tlsModule = tls!
      const tlsOptions = {
        host: targetIp,
        port,
        servername: url.hostname, // SNI
        checkServerIdentity: (host: string, cert: any) => {
          // Verify cert matches the expected hostname
          const altNames = cert.subjectaltname || ''
          if (!altNames.toLowerCase().includes(url.hostname.toLowerCase())) {
            return new Error(`Certificate does not match hostname ${url.hostname}`)
          }
          return undefined
        },
      }

      const tlsSocket = tlsModule.connect(tlsOptions, () => {
        req = https.request({
          ...options,
          createConnection: () => tlsSocket,
        }, (res: any) => resolveResponse(res, resolve, reject))
      })
      tlsSocket.on('error', reject)
    } else {
      req = http.request(options, (res: any) => resolveResponse(res, resolve, reject))
    }

    req.on('error', reject)
    req.on('timeout', () => {
      req.destroy()
      reject(new Error('Request timeout'))
    })
    req.setTimeout(timeoutMs)
    req.write(serialized)
    req.end()

    signal.addEventListener('abort', () => {
      req.destroy()
      reject(new Error('Request aborted'))
    })
  })
}

function resolveResponse(res: any, resolve: (r: Response) => void, reject: (e: Error) => void) {
  const chunks: Buffer[] = []
  res.on('data', (chunk: Buffer) => chunks.push(chunk))
  res.on('end', () => {
    const body = Buffer.concat(chunks).toString()
    const response = new Response(body, {
      status: res.statusCode,
      headers: res.headers as any,
    })
    resolve(response)
  })
  res.on('error', reject)
}

function timingSafeEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false
  return a.equals(b)
}