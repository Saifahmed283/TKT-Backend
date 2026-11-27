export const EGYPT_TIME_ZONE = 'Africa/Cairo'

const pad2 = (value: string): string => value.padStart(2, '0')

/** Ticket/event timestamps are always shown in Egypt local time, 12-hour clock. */
export function formatEgyptTicketDateTime(date: Date): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: EGYPT_TIME_ZONE,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
    hourCycle: 'h12',
  }).formatToParts(date)

  const pick = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? ''

  const weekday = pick('weekday')
  const day = pick('day')
  const month = pick('month')
  const hour = pad2(pick('hour'))
  const minute = pick('minute')
  const period = pick('dayPeriod').toUpperCase()

  return `${weekday}, ${day} ${month} at ${hour}:${minute} ${period}`
}

/** Calendar-day key (YYYY-MM-DD) in Egypt local time. */
export function egyptDateKey(date: Date): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: EGYPT_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date)
  const pick = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? ''
  return `${pick('year')}-${pick('month')}-${pick('day')}`
}
