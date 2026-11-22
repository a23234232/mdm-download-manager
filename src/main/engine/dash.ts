import { XMLParser } from 'fast-xml-parser'
import { UnsupportedError } from './errors'

export interface DashFragment {
  index: number
  url: string
  range?: string
}

export interface DashTrack {
  id: string
  type: 'video' | 'audio'
  mimeType?: string
  codecs?: string
  bandwidth: number
  width?: number
  height?: number
  language?: string
  initUrl?: string
  fragments: DashFragment[]
}

export interface DashPlan {
  video: DashTrack | null
  audio: DashTrack | null
  durationSeconds: number
  drmProtected: boolean
}

type Node = Record<string, unknown>

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  textNodeName: '#text',
  parseTagValue: false,
  trimValues: true,
  isArray: (name) => ['Period', 'AdaptationSet', 'Representation', 'S', 'SegmentURL', 'BaseURL'].includes(name)
})

function array<T>(value: unknown): T[] {
  if (value === undefined || value === null) return []
  return (Array.isArray(value) ? value : [value]) as T[]
}

function text(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (typeof value === 'number') return String(value)
  if (value && typeof value === 'object') {
    const inner = (value as Node)['#text']
    if (typeof inner === 'string' || typeof inner === 'number') return String(inner)
  }
  return undefined
}

function resolve(base: string, relative: string): string {
  try {
    return new URL(relative, base).toString()
  } catch {
    return relative
  }
}

export function parseIsoDuration(value: string | undefined): number {
  if (!value) return 0
  const match = /^P(?:(\d+(?:\.\d+)?)Y)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/i.exec(
    value
  )
  if (!match) return 0
  const [, years, months, days, hours, minutes, seconds] = match
  return (
    Number(years ?? 0) * 31_536_000 +
    Number(months ?? 0) * 2_592_000 +
    Number(days ?? 0) * 86_400 +
    Number(hours ?? 0) * 3_600 +
    Number(minutes ?? 0) * 60 +
    Number(seconds ?? 0)
  )
}

function baseOf(node: Node | undefined, parent: string): string {
  const values = array<unknown>(node?.BaseURL)
  const raw = text(values[0])
  return raw ? resolve(parent, raw) : parent
}

function replaceTemplate(template: string, values: Record<string, string | number>): string {
  return template.replace(/\$(RepresentationID|Bandwidth|Number|Time)(?:%0?(\d+)d)?\$/g, (_all, key: string, width?: string) => {
    const value = String(values[key] ?? '')
    if (width) return value.padStart(Number(width), '0')
    return value
  })
}

interface TemplateInfo {
  media: string
  initialization?: string
  startNumber: number
  duration?: number
  timescale: number
  timeline: Array<{ t?: number; d: number; r: number }>
}

function readTemplate(node: Node | undefined): TemplateInfo | undefined {
  if (!node) return undefined
  const template = node.SegmentTemplate as Node | undefined
  if (!template) return undefined
  const timelineNode = template.SegmentTimeline as Node | undefined
  return {
    media: String(template.media ?? ''),
    initialization: template.initialization ? String(template.initialization) : undefined,
    startNumber: Number(template.startNumber ?? 1) || 1,
    duration: template.duration !== undefined ? Number(template.duration) : undefined,
    timescale: Number(template.timescale ?? 1) || 1,
    timeline: array<Node>(timelineNode?.S).map((item) => ({
      t: item.t !== undefined ? Number(item.t) : undefined,
      d: Number(item.d ?? 0),
      r: Number(item.r ?? 0)
    }))
  }
}

function buildTemplateFragments(
  template: TemplateInfo,
  baseUrl: string,
  representationId: string,
  bandwidth: number,
  durationSeconds: number
): DashFragment[] {
  const urls: string[] = []
  if (template.timeline.length > 0) {
    let time = 0
    const times: number[] = []
    for (const entry of template.timeline) {
      if (entry.t !== undefined) time = entry.t
      const repeats = entry.r >= 0 ? entry.r + 1 : 1
      for (let i = 0; i < repeats; i++) {
        times.push(time)
        time += entry.d
      }
    }
    for (const value of times) {
      urls.push(
        resolve(
          baseUrl,
          replaceTemplate(template.media, {
            RepresentationID: representationId,
            Bandwidth: bandwidth,
            Number: 1,
            Time: value
          })
        )
      )
    }
  } else {
    const segmentDuration = template.duration ? template.duration / template.timescale : 4
    const count = Math.max(1, Math.ceil(durationSeconds / segmentDuration))
    for (let index = 0; index < count; index++) {
      urls.push(
        resolve(
          baseUrl,
          replaceTemplate(template.media, {
            RepresentationID: representationId,
            Bandwidth: bandwidth,
            Number: template.startNumber + index,
            Time: index * template.duration!
          })
        )
      )
    }
  }
  return urls.map((url, index) => ({ index, url }))
}

function buildSegmentList(node: Node, baseUrl: string): DashFragment[] {
  const list = node.SegmentList as Node | undefined
  if (!list) return []
  return array<Node>(list.SegmentURL).flatMap((entry, index) => {
    const media = String(entry.media ?? '')
    if (!media) return []
    const range = entry.mediaRange ? `bytes=${String(entry.mediaRange)}` : undefined
    return [{ index, url: resolve(baseUrl, media), range }]
  })
}
function initFromTemplate(template: TemplateInfo | undefined, baseUrl: string, id: string, bandwidth: number): string | undefined {
  if (!template?.initialization) return undefined
  return resolve(
    baseUrl,
    replaceTemplate(template.initialization, { RepresentationID: id, Bandwidth: bandwidth, Number: 0, Time: 0 })
  )
}

function hasDrm(node: Node | undefined): boolean {
  if (!node) return false
  return Boolean(node.ContentProtection)
}

export function parseDashManifest(text: string, manifestUrl: string): DashPlan {
  let root: Node
  try {
    const parsed = parser.parse(text) as Node
    root = (parsed.MPD ?? parsed) as Node
  } catch (error) {
    throw new UnsupportedError(`DASH 清单解析失败：${(error as Error).message}`)
  }
  if (!root || typeof root !== 'object') throw new UnsupportedError('DASH 清单为空')
  const mpdBase = baseOf(root, manifestUrl)
  const periods = array<Node>(root.Period)
  if (periods.length === 0) throw new UnsupportedError('DASH 清单中没有 Period')
  const period = periods[0]!
  const periodBase = baseOf(period, mpdBase)
  const periodDuration = parseIsoDuration(String(period.duration ?? '')) || parseIsoDuration(String(root.mediaPresentationDuration ?? ''))
  const adaptations = array<Node>(period.AdaptationSet)
  if (adaptations.length === 0) throw new UnsupportedError('DASH 清单中没有 AdaptationSet')
  const drmProtected = adaptations.some(hasDrm)

  const tracks: DashTrack[] = []
  for (const adaptation of adaptations) {
    const adaptationBase = baseOf(adaptation, periodBase)
    const adaptationType = String(adaptation.contentType ?? '').toLowerCase()
    const mime = String(adaptation.mimeType ?? '')
    const representations = array<Node>(adaptation.Representation)
    if (representations.length === 0) continue
    for (const representation of representations) {
      const repBase = baseOf(representation, adaptationBase)
      const id = String(representation.id ?? '0')
      const bandwidth = Number(representation.bandwidth ?? 0) || 0
      const repMime = String(representation.mimeType ?? mime)
      const type: 'video' | 'audio' | null = adaptationType === 'video' || repMime.startsWith('video/')
        ? 'video'
        : adaptationType === 'audio' || repMime.startsWith('audio/')
          ? 'audio'
          : null
      if (!type) continue
      const template = readTemplate(representation) ?? readTemplate(adaptation) ?? readTemplate(period)
      let fragments = buildSegmentList(representation, repBase)
      if (fragments.length === 0 && template?.media) {
        fragments = buildTemplateFragments(template, repBase, id, bandwidth, periodDuration)
      }
      if (fragments.length === 0) continue
      tracks.push({
        id,
        type,
        mimeType: repMime || undefined,
        codecs: representation.codecs ? String(representation.codecs) : undefined,
        bandwidth,
        width: representation.width ? Number(representation.width) : undefined,
        height: representation.height ? Number(representation.height) : undefined,
        language: adaptation.lang ? String(adaptation.lang) : undefined,
        initUrl: initFromTemplate(template, repBase, id, bandwidth) ?? undefined,
        fragments
      })
    }
  }

  const video = tracks.filter((track) => track.type === 'video').sort((a, b) => b.bandwidth - a.bandwidth)[0] ?? null
  const audio = tracks.filter((track) => track.type === 'audio').sort((a, b) => b.bandwidth - a.bandwidth)[0] ?? null
  if (!video && !audio) throw new UnsupportedError('DASH 清单中没有可下载的音视频轨道')
  return {
    video,
    audio,
    durationSeconds: periodDuration,
    drmProtected
  }
}