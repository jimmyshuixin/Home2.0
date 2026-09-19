export type PhotographyInfo = {
  cameraMake?: string; cameraModel?: string; lensMake?: string; lensModel?: string
  focalLengthMm?: number; focalLength35mm?: number; exposureSeconds?: number
  aperture?: number; iso?: number; takenAt?: string; takenDate?: string; timezoneOffset?: string
}
function equipment(make?: string, model?: string): string {
  return model && make && !model.toLowerCase().startsWith(make.toLowerCase()) ? `${make} ${model}` : model || make || ''
}
function decimal(value: number): string { return Number(value.toFixed(2)).toString() }
export function photographyRows(info?: PhotographyInfo, hideDate = false): Array<{ label: string; value: string }> {
  if (!info) return []
  const rows: Array<{ label: string; value: string }> = []
  const add = (label: string, value?: string) => { if (value) rows.push({ label, value }) }
  const positive = (value?: number): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0
  add('相机', equipment(info.cameraMake, info.cameraModel))
  add('镜头', equipment(info.lensMake, info.lensModel))
  if (positive(info.focalLengthMm)) add('焦距', `${decimal(info.focalLengthMm)} mm${positive(info.focalLength35mm) ? `（等效 ${decimal(info.focalLength35mm)} mm）` : ''}`)
  if (positive(info.aperture)) add('光圈', `f/${decimal(info.aperture)}`)
  if (positive(info.exposureSeconds)) add('快门', info.exposureSeconds < 1 ? `1/${decimal(1 / info.exposureSeconds)} s` : `${decimal(info.exposureSeconds)} s`)
  if (positive(info.iso)) add('感光度', `ISO ${info.iso}`)
  if (!hideDate) add('拍摄时间', (info.takenAt?.replace('T', ' ') || info.takenDate || '') + (info.timezoneOffset && info.takenAt ? ` UTC${info.timezoneOffset}` : ''))
  return rows
}
