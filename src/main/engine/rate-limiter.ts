export class RateLimiter {
  private rate = 0
  private nextAvailable = 0

  constructor(rate = 0) {
    this.rate = Math.max(0, rate)
  }

  setRate(rate: number): void {
    this.rate = Math.max(0, rate)
    this.nextAvailable = 0
  }

  getRate(): number {
    return this.rate
  }

  async consume(bytes: number, signal?: AbortSignal): Promise<void> {
    if (this.rate <= 0 || bytes <= 0) return
    const now = performance.now()
    const start = Math.max(now, this.nextAvailable)
    const finish = start + (bytes / this.rate) * 1000
    this.nextAvailable = finish
    const wait = start - now
    if (wait > 0) await sleep(wait, signal)
    const remaining = finish - performance.now()
    if (remaining > 0) await sleep(remaining, signal)
  }
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
