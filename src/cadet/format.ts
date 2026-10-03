/** A record's time as the cadet reads it on their phone: local date and time, no seconds. */
export const formatWhen = (iso: string) => {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })
}
