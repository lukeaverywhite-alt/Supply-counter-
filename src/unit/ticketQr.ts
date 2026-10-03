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

/** Reads the text of a QR from a camera photo or a saved/shared image, without uploading it anywhere. */
export async function ticketCodeFromQrImage(file: File) {
  const image = await loadImage(file)
  const canvas = document.createElement('canvas'), context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) throw new Error('This browser cannot read QR images.')
  canvas.width = image.naturalWidth; canvas.height = image.naturalHeight
  context.drawImage(image, 0, 0)
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height)
  const decoded = jsQR(pixels.data, pixels.width, pixels.height, { inversionAttempts: 'attemptBoth' })
  if (!decoded) throw new Error('No QR code was found in that image. Try a clearer, closer picture.')
  return decoded.data
}
