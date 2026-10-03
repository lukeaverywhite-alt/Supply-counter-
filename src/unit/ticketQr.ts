import jsQR from 'jsqr'
import QRCode from 'qrcode'

/** The QR carries the ticket's short code as plain text, so it reads the same as the code typed (ADR 012, D2). */
export const ticketQrDataUrl = (code: string) => QRCode.toDataURL(code, { errorCorrectionLevel: 'M', margin: 2, width: 720 })

function loadImage(file: File) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image(), url = URL.createObjectURL(file)
    image.onload = () => { URL.revokeObjectURL(url); resolve(image) }
    image.onerror = () => { URL.revokeObjectURL(url); reject(new Error('That image could not be opened.')) }
    image.src = url
  })
}

/** A phone's photo is about 12 MP, and jsQR does badly on a screen photographed at that size (moire, glare), so it is also tried shrunk. */
const DECODE_SIZES = [1600, 1000, 600]

type Detector = { detect: (image: ImageBitmapSource) => Promise<{ rawValue: string }[]> }
type DetectorConstructor = new (options: { formats: string[] }) => Detector

/** The browser's own QR reader where there is one (Chrome and Android); it copes with photos better than a script can. */
async function detectNatively(image: HTMLImageElement) {
  const Detector = (globalThis as { BarcodeDetector?: DetectorConstructor }).BarcodeDetector
  if (!Detector) return undefined
  try { return (await new Detector({ formats: ['qr_code'] }).detect(image))[0]?.rawValue || undefined } catch { return undefined }
}

/** Reads the text of a QR from a camera photo or a saved/shared image, without uploading it anywhere. */
export async function ticketCodeFromQrImage(file: File) {
  const image = await loadImage(file)
  const native = await detectNatively(image)
  if (native) return native
  const canvas = document.createElement('canvas'), context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) throw new Error('This browser cannot read QR images.')
  const longest = Math.max(image.naturalWidth, image.naturalHeight)
  for (const size of new Set(DECODE_SIZES.map(side => Math.min(side, longest)))) {
    const scale = size / longest
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale)); canvas.height = Math.max(1, Math.round(image.naturalHeight * scale))
    context.drawImage(image, 0, 0, canvas.width, canvas.height)
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height)
    const decoded = jsQR(pixels.data, pixels.width, pixels.height, { inversionAttempts: 'attemptBoth' })
    if (decoded?.data) return decoded.data
  }
  throw new Error('No QR code was found in that image. Try a clearer, closer picture.')
}
