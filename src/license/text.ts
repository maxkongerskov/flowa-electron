// Fill brand templates. The words and URLs live in the product catalog, not here.

export function fillTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (token, key: string) => (key in vars ? vars[key] : token))
}

export function remainingMinutesLabel(template: string, remainingSeconds: number): string {
  const minutes = remainingSeconds <= 0 ? 0 : Math.ceil(remainingSeconds / 60)
  return fillTemplate(template, { minutes: String(minutes) })
}

/** Local date and time, stable across runtimes (not toLocaleString). */
export function formatRestrictWhen(ms: number): string {
  const d = new Date(ms)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()} kl. ${pad(d.getHours())}.${pad(d.getMinutes())}`
}
