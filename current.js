import * as BareMux from './tide/index.mjs'
import './su.bundle.mjs'
import './su.config.mjs'
import './su.kernel.mjs'

self.BareMux = BareMux
const uv = new self.UVServiceWorker()
const connection = new BareMux.BareMuxConnection('./tide/worker.js?raw=true')

let transportReady = false

async function setupTransport() {
  const wispUrl = self.__uv$config.wisp

  try {
    const transportUrl = new URL('./boat/index.mjs', self.location.href).href
    await connection.setTransport(transportUrl, [{ wisp: wispUrl }])
    console.log('[SW] Boat transport configured (Remote):', wispUrl)
    transportReady = true
  } catch (err) {
    console.error('[SW] Failed to set Wisp transport:', err)
  }
}

const transportPromise = setupTransport()

self.addEventListener('fetch', (event) => {
  if (event.request.url.startsWith(location.origin + self.__uv$config.prefix)) {
    event.respondWith(
      (async () => {
        await transportPromise
        return await uv.fetch(event)
      })()
    )
  }
})
