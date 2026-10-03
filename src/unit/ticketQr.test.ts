import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { encodeTicketCode, makeTicketSecret } from '../identity/ticketCode'
import { installFakePictures, phonePhoto, pictureFile, plainPicture, ticketQrRaster, type Raster } from '../test/qrPhoto'
import { ticketCodeFromQrImage } from './ticketQr'

describe('reading a ticket QR from a picture (the decoder is the real one)', { timeout: 120_000 }, () => {
  let remove: () => void, code: string, qr: Raster
  beforeEach(async () => { remove = installFakePictures(); code = encodeTicketCode(makeTicketSecret()); qr = await ticketQrRaster(code) })
  afterEach(() => remove())

  it('reads the code from a phone-sized photo of the QR on a screen (3200 px on its longest side, with a margin)', async () => {
    expect(await ticketCodeFromQrImage(pictureFile(phonePhoto(qr, 3200)))).toBe(code)
  })

  it('reads the code from a small saved picture (300 px) and from the QR picture the app makes', async () => {
    expect(await ticketCodeFromQrImage(pictureFile(plainPicture(qr, 300, 20), 'small.png'))).toBe(code)
    expect(await ticketCodeFromQrImage(pictureFile(qr, 'app.png'))).toBe(code)
  })

  it('says plainly that there is no QR in a picture without one', async () => {
    const blank: Raster = { width: 3000, height: 2000, data: new Uint8ClampedArray(3000 * 2000 * 4).fill(200) }
    await expect(ticketCodeFromQrImage(pictureFile(blank, 'blank.jpg'))).rejects.toThrow('No QR code was found in that image. Try a clearer, closer picture.')
  })

  it('asks the browser\'s own QR reader first when there is one, and falls back to the script reader when it finds nothing or fails', async () => {
    const detect = vi.fn(async () => [{ rawValue: 'FROM-THE-BROWSER' }])
    vi.stubGlobal('BarcodeDetector', class { detect = detect })
    expect(await ticketCodeFromQrImage(pictureFile(plainPicture(qr, 300, 20), 'a.png'))).toBe('FROM-THE-BROWSER')
    detect.mockResolvedValueOnce([])
    expect(await ticketCodeFromQrImage(pictureFile(plainPicture(qr, 300, 20), 'b.png'))).toBe(code)
    detect.mockRejectedValueOnce(new Error('unsupported'))
    expect(await ticketCodeFromQrImage(pictureFile(plainPicture(qr, 300, 20), 'c.png'))).toBe(code)
    expect(detect).toHaveBeenCalledTimes(3)
  })
})
