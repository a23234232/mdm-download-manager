import type { SegmentState } from '@shared/types'
import { MAX_SEGMENTS, MIN_SEGMENT_BYTES } from '@shared/types'
import { clamp } from '@shared/format'

export interface SegmentPlanOptions {
  requested: number
  totalBytes: number
  rangeSupported: boolean
}

export function planSegments(options: SegmentPlanOptions): SegmentState[] {
  const requested = clamp(Math.floor(options.requested) || 1, 1, MAX_SEGMENTS)
  if (!options.rangeSupported || options.totalBytes <= 0) {
    return [{ index: 0, start: 0, end: Math.max(0, options.totalBytes - 1), downloaded: 0, status: 'pending' }]
  }
  const maxBySize = Math.max(1, Math.floor(options.totalBytes / MIN_SEGMENT_BYTES))
  const count = Math.min(requested, maxBySize, MAX_SEGMENTS, options.totalBytes)
  const size = Math.ceil(options.totalBytes / count)
  const segments: SegmentState[] = []
  for (let index = 0; index < count; index++) {
    const start = index * size
    const end = Math.min(options.totalBytes - 1, start + size - 1)
    if (start > end) break
    segments.push({ index, start, end, downloaded: 0, status: 'pending' })
  }
  return segments
}

export function segmentLength(segment: Pick<SegmentState, 'start' | 'end'>): number {
  return Math.max(0, segment.end - segment.start + 1)
}

export function resetSegments(segments: SegmentState[]): void {
  for (const segment of segments) {
    segment.downloaded = 0
    segment.status = 'pending'
  }
}

export function rangeForSegment(segment: Pick<SegmentState, 'start' | 'end' | 'downloaded'>): string {
  return `bytes=${segment.start + segment.downloaded}-${segment.end}`
}

export function sumSegments(segments: SegmentState[]): number {
  return segments.reduce((total, segment) => total + segment.downloaded, 0)
}

export function allSegmentsDone(segments: SegmentState[]): boolean {
  return segments.every((segment) => segment.downloaded >= segmentLength(segment))
}
