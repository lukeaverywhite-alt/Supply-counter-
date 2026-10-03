import { PNG } from 'pngjs'
import { vi } from 'vitest'
import { ticketQrDataUrl } from '../unit/ticketQr'

/** jsdom has no image decoder and no canvas. These stand-ins give the QR reader pictures and a 2D canvas that scales the way a browser's does (area average when shrinking). */
export type Raster = { width: number; height: number; data: Uint8ClampedArray }

const rasters = new Map<string, Raster>()
let seed = 1
const random = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32

/** The QR picture the app itself makes for a ticket code, as pixels. */
export async function ticketQrRaster(code: string): Promise<Raster> {
  const png = PNG.sync.read(Buffer.from((await ticketQrDataUrl(code)).split(',')[1], 'base64'))
  return { width: png.width, height: png.height, data: new Uint8ClampedArray(png.data) }
}

const luma = (raster: Raster, x: number, y: number) => raster.data[(Math.min(raster.height - 1, Math.max(0, y)) * raster.width + Math.min(raster.width - 1, Math.max(0, x))) * 4]

/**
 * A phone's photo of the QR on another screen: the picture is shown about `fill` of the photo's short side, a little off-centre on a grey
 * surround, soft (blurred), with a brightness gradient (glare), a faint pixel-grid pattern (moire) and sensor noise.
 */
export function phonePhoto(qr: Raster, longest: number, fill = 0.4): Raster {
  const width = longest, height = Math.round(longest * 0.75), data = new Uint8ClampedArray(width * height * 4)
  const side = Math.round(height * fill), left = Math.round(width * 0.3), top = Math.round(height * 0.28), scale = qr.width / side
  const blur = Math.max(1, Math.round(side / qr.width * 1.6))
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    let value = 90
    if (x >= left && x < left + side && y >= top && y < top + side) {
      let sum = 0, count = 0
      for (let dy = -blur; dy <= blur; dy += blur) for (let dx = -blur; dx <= blur; dx += blur) { sum += luma(qr, Math.floor((x - left + dx) * scale), Math.floor((y - top + dy) * scale)); count++ }
      value = sum / count
      value = value * (0.55 + 0.45 * (x - left) / side) + (((x >> 1) + (y >> 1)) % 2 ? 14 : -14)
    }
    value += (random() - 0.5) * 40
    const at = (y * width + x) * 4
    data[at] = data[at + 1] = data[at + 2] = value; data[at + 3] = 255
  }
  return { width, height, data }
}

/** A plain scaled copy of the QR picture itself (a screenshot or a saved image, not a photo). */
export function plainPicture(qr: Raster, longest: number, margin = 0): Raster {
  const side = longest - 2 * margin, data = new Uint8ClampedArray(longest * longest * 4).fill(255)
  for (let y = 0; y < side; y++) for (let x = 0; x < side; x++) {
    const value = luma(qr, Math.floor(x * qr.width / side), Math.floor(y * qr.height / side)), at = ((y + margin) * longest + x + margin) * 4
    data[at] = data[at + 1] = data[at + 2] = value; data[at + 3] = 255
  }
  return { width: longest, height: longest, data }
}

/** A `File` that the stubbed `Image` shows as `raster`. */
export function pictureFile(raster: Raster, name = 'photo.jpg') {
  const file = new File(['picture'], name, { type: 'image/jpeg' })
  rasters.set(name, raster)
  return file
}

class FakeCanvasContext {
  constructor(private canvas: HTMLCanvasElement) {}
  private pixels?: Raster
  drawImage(image: { raster: Raster }, _x: number, _y: number, width = image.raster.width, height = image.raster.height) {
    const source = image.raster, out = new Uint8ClampedArray(width * height * 4)
    const stepX = source.width / width, stepY = source.height / height
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const x0 = Math.floor(x * stepX), x1 = Math.max(x0 + 1, Math.floor((x + 1) * stepX)), y0 = Math.floor(y * stepY), y1 = Math.max(y0 + 1, Math.floor((y + 1) * stepY))
      let sum = 0, count = 0
      for (let sy = y0; sy < y1; sy++) for (let sx = x0; sx < x1; sx++) { sum += source.data[(sy * source.width + sx) * 4]; count++ }
      const at = (y * width + x) * 4
      out[at] = out[at + 1] = out[at + 2] = sum / count; out[at + 3] = 255
    }
    this.pixels = { width, height, data: out }
  }
  getImageData(_x: number, _y: number, width: number, height: number) {
    if (!this.pixels || this.pixels.width !== width || this.pixels.height !== height) throw new Error(`nothing drawn at ${width}x${height} (canvas ${this.canvas.width}x${this.canvas.height})`)
    return { width, height, data: this.pixels.data }
  }
}

/** Install the stand-ins; call the returned function to remove them. */
export function installFakePictures() {
  const names = new Map<string, string>()
  vi.stubGlobal('Image', class {
    onload?: () => void; onerror?: () => void; raster?: Raster
    get naturalWidth() { return this.raster?.width ?? 0 }
    get naturalHeight() { return this.raster?.height ?? 0 }
    set src(url: string) { queueMicrotask(() => { this.raster = rasters.get(names.get(url) ?? ''); if (this.raster) this.onload?.(); else this.onerror?.() }) }
  })
  let counter = 0
  vi.spyOn(URL, 'createObjectURL').mockImplementation(file => { const url = `blob:test/${counter++}`; names.set(url, (file as File).name); return url })
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
  const contexts = new WeakMap<HTMLCanvasElement, FakeCanvasContext>()
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement) {
    if (!contexts.has(this)) contexts.set(this, new FakeCanvasContext(this))
    return contexts.get(this) as unknown as CanvasRenderingContext2D
  } as never)
  return () => { vi.unstubAllGlobals(); vi.restoreAllMocks() }
}
