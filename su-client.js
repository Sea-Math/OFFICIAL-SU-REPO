/**
 * SuClient - Simplified client
 *
 * Manages the proxy connection, URL rewriting, and navigation state.
 * Handles the initialization of the underlying transport (Boat) and the Service Worker.
 */
class SuClient {
  /**
   * Available events that can be subscribed to.
   * @readonly
   */
  static get EVENTS() {
    return {
      READY: 'ready',
      ERROR: 'error',
      NAVIGATING: 'navigating',
      URL_CHANGE: 'urlChange',
      TITLE_CHANGE: 'titleChange',
      FAVICON_CHANGE: 'faviconChange',
      STATUS_CHANGE: 'statusChange',
      LOADING_START: 'loadingStart',
      LOADING_STOP: 'loadingStop',
    }
  }

  /**
   * Creates an instance of SuClient.
   * @param {Object} [options={}] - Configuration options.
   * @param {string} [options.uvConfigPath='/su.config.js'] - Path to the generated configuration file.
   * @param {string} [options.uvBundlePath='/su.bundle.js'] - Path to the Boat bundle.
   * @param {string} [options.uvClientPath='/su.canvas.js'] - Path to the Boat client script.
   * @param {string} [options.tidePath='/tide/index.js'] - Path to the BareMux library.
   * @param {string} [options.searchEngine='https://duckduckgo.com/?q=%s'] - Default search engine template.
   * @param {string|HTMLIFrameElement} [options.frame] - The iframe element or ID/selector to manage.
   * @param {number} [options.timeout=5000] - Initialization timeout in milliseconds.
   */
  constructor(options = {}) {
    this.options = {
      uvConfigPath: 'su.config.mjs',
      uvBundlePath: 'su.bundle.mjs',
      uvClientPath: 'su.canvas.mjs',
      tidePath: 'tide/index.mjs',
      workerPath: 'tide/worker.js',
      searchEngine: 'https://duckduckgo.com/?q=%s',
      timeout: 5000,
      loadBareMux: true,
      loadBoat: true,
      ...options,
    }

    this.engine = 'boat'
    // Use the name from storage, or fallback to the config if available once init runs
    this.searchEngine = localStorage.getItem('su_search_engine') || 'duckduckgo'

    /**
     * @typedef {Object} SuState
     * @property {boolean} initialized - Whether init() has been called.
     * @property {boolean} ready - Whether the client is ready to navigate.
     * @property {boolean} loading - Whether a page is currently loading in the proxied frame.
     * @property {string} engine - Current transport engine (default: 'boat').
     * @property {string} searchEngine - Current search engine identifier.
     * @property {boolean} currentWorkerRegistered - Whether the service worker is registered.
     * @property {Error|null} error - Last error encountered, if any.
     */
    this.state = {
      initialized: false,
      ready: false,
      loading: false,
      engine: this.engine,
      searchEngine: this.searchEngine,
      currentWorkerRegistered: false,
      error: null,
    }

    this.listeners = {}
    this.iframe = null
    this._pollingInterval = null

    // Automatically set frame if provided in options
    if (this.options.frame) {
      this.setFrame(this.options.frame)
    }
  }

  /**
   * Sets the preferred search engine.
   * @param {string} engine - The identifier of the search engine (e.g., 'duckduckgo', 'google').
   */
  setSearchEngine(engine) {
    this.searchEngine = engine
    localStorage.setItem('su_search_engine', engine)
    this.updateState({ searchEngine: engine })
  }

  /**
   * Initializes the client.
   * Loads required scripts, establishes the transport connection, and registers the Service Worker.
   * @returns {Promise<void>}
   * @emits ready
   * @emits error
   */
  async init() {
    if (this.state.initialized) return

    // Environment checks
    if (!('serviceWorker' in navigator)) {
      const isSecure = window.isSecureContext
      const protocol = location.protocol
      const hostname = location.hostname

      const debugInfo = `
        Debug Info:
        - Secure Context: ${isSecure}
        - Protocol: ${protocol}
        - Hostname: ${hostname}
        - ServiceWorker in navigator: ${'serviceWorker' in navigator}
      `

      const msg = `Service Workers are not supported. This application requires a secure context (HTTPS or localhost).\n${debugInfo}`
      const error = new Error(msg)
      console.error(msg)
      this.updateState({ error: msg })
      this.emit(SuClient.EVENTS.ERROR, error)
      return
    }

    if (!('SharedWorker' in window)) {
      console.warn('SharedWorker not supported. Performance might be degraded.')
    }

    this.updateState({ initialized: true })

    try {
      // Load dependencies as ES modules
      if (this.options.loadBareMux) {
        const BareMuxModule = await import(new URL(this.options.tidePath, location.href).href)
        window.BareMux = BareMuxModule
      }

      if (this.options.loadBoat) {
        await this.loadScript(this.options.uvBundlePath + '?raw=true')
        await this.loadScript(this.options.uvConfigPath + '?raw=true')
        await this.loadScript(this.options.uvClientPath + '?raw=true')
      }

      let workerUrl = new URL(this.options.workerPath, location.href).href

      // Fetch worker content to bypass esm.sh module shims and ensure raw script
      try {
        const fetchUrl = workerUrl + (workerUrl.includes('?') ? '&' : '?') + 'raw=true'
        const response = await fetch(fetchUrl)
        if (!response.ok) throw new Error(`Failed to fetch worker: ${response.statusText}`)
        const workerScript = await response.text()
        const blob = new Blob([workerScript], { type: 'application/javascript' })
        workerUrl = URL.createObjectURL(blob)
      } catch (e) {
        console.warn('Failed to fetch worker raw content, falling back to direct URL:', e)
        // Fallback to original URL (with cache buster if it was added)
        workerUrl = new URL(this.options.workerPath + '?v=' + Date.now(), location.href).href
      }

      const connection = new window.BareMux.BareMuxConnection(workerUrl)
      const wispURL = window.__uv$config.wisp
      const transportUrl = new URL('boat/index.mjs', location.href).href

      console.log('🔧 Setting transport to Wisp (Remote Server):', wispURL)
      await connection.setTransport(transportUrl, [{ wisp: wispURL }])
      console.log('✅ Boat transport configured')

      // Force update of SW
      await this.registerServiceWorker('current.js?v=' + Date.now(), 'module')

      this.encodeUrl = (url) => {
        return window.location.origin + window.__uv$config.prefix + window.__uv$config.encodeUrl(url)
      }
      this.decodeUrl = (url) => {
        const prefix = window.__uv$config.prefix
        if (url.includes(prefix)) {
          return window.__uv$config.decodeUrl(url.split(prefix)[1])
        }
        return url
      }

      this.updateState({ ready: true })
      this.emit(SuClient.EVENTS.READY)
    } catch (error) {
      console.error('SuClient Init Error:', error)
      this.updateState({ error: error.message })
      this.emit(SuClient.EVENTS.ERROR, error)
    }
  }

  /**
   * Loads a script dynamically.
   * @private
   * @param {string} src - The script source URL.
   * @param {string} [type='text/javascript'] - The script type (e.g., 'module').
   * @returns {Promise<void>}
   */
  async loadScript(src, type = 'text/javascript') {
    return new Promise((resolve, reject) => {
      const script = document.createElement('script')
      script.src = src
      script.type = type
      script.onload = () => resolve()
      script.onerror = () => reject(new Error(`Failed to load script: ${src}`))
      document.head.appendChild(script)
    })
  }

  /**
   * Registers the Service Worker.
   * @private
   * @param {string} path - The service worker script path.
   * @param {string} [type='classic'] - The worker type ('classic' or 'module').
   * @returns {Promise<void>}
   */
  async registerServiceWorker(path, type = 'classic') {
    try {
      await navigator.serviceWorker.register(path, { scope: './', type })
      await navigator.serviceWorker.ready
      this.updateState({ currentWorkerRegistered: true })

      if (!navigator.serviceWorker.controller) {
        window.location.reload()
      }
    } catch (error) {
      throw new Error(`Worker registration failed: ${error.message}`)
    }
  }

  /**
   * Encodes a URL or search query and navigates the managed frame (if set).
   * @param {string} url - The URL to navigate to, or a search query.
   * @returns {string} The fully qualified, proxied URL.
   * @emits loadingStart
   * @emits navigating
   */
  navigate(url) {
    if (!this.state.ready) throw new Error('Client not ready')
    const parsedUrl = this.parseUrl(url)
    const encodedUrl = this.encodeUrl(parsedUrl.toString())

    this.updateState({ loading: true })
    this.emit(SuClient.EVENTS.LOADING_START)
    this.emit(SuClient.EVENTS.NAVIGATING, { original: url, encoded: encodedUrl })

    if (this.iframe) {
      this.iframe.src = encodedUrl
    }

    return encodedUrl
  }

  /**
   * Decodes a proxied URL.
   * @param {string} url - The proxied URL.
   * @returns {string} The original URL.
   */
  decode(url) {
    if (!this.state.ready) return url
    return this.decodeUrl(url)
  }

  /**
   * Sets the iframe element to be managed by the client.
   * Automatically handles event listeners and lifecycle tracking.
   * @param {HTMLIFrameElement|string} iframeOrSelector - The iframe element or a CSS selector.
   */
  setFrame(iframeOrSelector) {
    // Resolve element
    let element = iframeOrSelector
    if (typeof iframeOrSelector === 'string') {
      element = document.getElementById(iframeOrSelector) || document.querySelector(iframeOrSelector)
    }

    if (!element || element.tagName !== 'IFRAME') {
      throw new Error('Invalid frame element provided')
    }

    // Cleanup previous if exists (though usually singleton)
    if (this.iframe && this._pollingInterval) {
      clearInterval(this._pollingInterval)
    }

    this.iframe = element
    this._attachListeners(this.iframe)
  }

  /**
   * Internal method to attach listeners to the active frame.
   * @private
   */
  _attachListeners(iframe) {
    const handleLoadStart = () => {
      if (!this.state.loading) {
        this.updateState({ loading: true })
        this.emit(SuClient.EVENTS.LOADING_START)
      }
    }

    const checkMetadata = () => {
      try {
        if (!iframe.contentDocument) return

        // Title
        const title = iframe.contentDocument.title
        if (title && title !== this._lastTitle) {
          this._lastTitle = title
          this.emit(SuClient.EVENTS.TITLE_CHANGE, title)
        }

        // Favicon
        const iconLink = iframe.contentDocument.querySelector("link[rel*='icon']")
        const favicon = iconLink ? iconLink.href : ''
        if (favicon !== this._lastFavicon) {
          this._lastFavicon = favicon
          this.emit(SuClient.EVENTS.FAVICON_CHANGE, favicon)
        }
      } catch (e) {}
    }

    const handleLoadStop = () => {
      try {
        const encodedUrl = iframe.contentWindow.location.href

        // Stop loading state
        this.updateState({ loading: false })
        this.emit(SuClient.EVENTS.LOADING_STOP)

        // Check metadata immediately on load
        checkMetadata()

        if (this._lastUrl === encodedUrl) return
        this._lastUrl = encodedUrl
        const decodedUrl = this.decode(encodedUrl)
        this.emit(SuClient.EVENTS.URL_CHANGE, { original: encodedUrl, decoded: decodedUrl })

        // Re-setup listener for next navigation
        setupInternalTracking()
      } catch (err) {}
    }

    const setupInternalTracking = () => {
      try {
        // Intercept internal reloads/navigating away
        iframe.contentWindow.addEventListener('beforeunload', handleLoadStart)
        iframe.contentWindow.addEventListener('unload', handleLoadStart)
      } catch (err) {}
    }

    iframe.addEventListener('load', handleLoadStop)

    // Initial setup
    setupInternalTracking()

    // Polling fallback for URL changes (SPA support) and safety check
    this._pollingInterval = setInterval(() => {
      try {
        // Check metadata periodically
        checkMetadata()

        const currentUrl = iframe.contentWindow.location.href

        // 1. Detect URL changes (e.g. pushState/SPAs)
        if (currentUrl !== this._lastUrl) {
          this._lastUrl = currentUrl
          const decodedUrl = this.decode(currentUrl)
          this.emit(SuClient.EVENTS.URL_CHANGE, { original: currentUrl, decoded: decodedUrl })

          // Re-attach listeners as the DOM might be new or updated
          setupInternalTracking()
        }

        // 2. Safety: If we think we are loading, but the frame is actually done, stop loading.
        if (this.state.loading && iframe.contentDocument && iframe.contentDocument.readyState === 'complete') {
          this.updateState({ loading: false })
          this.emit(SuClient.EVENTS.LOADING_STOP)
        }
      } catch (e) {}
    }, 500)
  }

  /**
   * Returns the current state of the client.
   * @returns {SuState}
   */
  getState() {
    return { ...this.state }
  }

  /**
   * Parses user input into a valid URL object.
   * Automatically handles search queries using the configured engine.
   * @private
   * @param {string} input - The raw user input.
   * @returns {URL} The parsed URL.
   */
  parseUrl(input) {
    const trimmed = input.trim()
    try {
      return new URL(trimmed)
    } catch {
      try {
        const withProtocol = new URL('http://' + trimmed)
        if (withProtocol.hostname.includes('.')) return withProtocol
      } catch {}

      const searchUrl = (window.__uv$config && window.__uv$config.searchEngine) || this.options.searchEngine
      return new URL(searchUrl.replace('%s', encodeURIComponent(trimmed)))
    }
  }

  /**
   * Registers an event listener.
   * @param {string} event - The name of the event (use SuClient.EVENTS).
   * @param {function} callback - The function to call when the event is emitted.
   */
  on(event, callback) {
    if (!this.listeners[event]) this.listeners[event] = []
    this.listeners[event].push(callback)
  }

  /**
   * Emits an event to registered listeners.
   * @private
   * @param {string} event - The name of the event.
   * @param {*} data - The data to pass to listeners.
   */
  emit(event, data) {
    if (!this.listeners[event]) return
    this.listeners[event].forEach((callback) => callback(data))
  }

  /**
   * Updates the internal state and emits a statusChange event.
   * @private
   * @param {Object} updates - The state updates to apply.
   */
  updateState(updates) {
    Object.assign(this.state, updates)
    this.emit(SuClient.EVENTS.STATUS_CHANGE, { ...this.state })
  }

  /**
   * Navigates the managed frame back in history.
   */
  goBack() {
    if (this.iframe && this.iframe.contentWindow) {
      this.iframe.contentWindow.history.back()
    }
  }

  /**
   * Navigates the managed frame forward in history.
   */
  goForward() {
    if (this.iframe && this.iframe.contentWindow) {
      this.iframe.contentWindow.history.forward()
    }
  }

  /**
   * Reloads the current page in the managed frame.
   */
  reloadFrame() {
    if (this.iframe && this.iframe.contentWindow) {
      this.iframe.contentWindow.location.reload()
    }
  }

  /**
   * Reloads the entire page (parent window).
   * Useful when the Service Worker needs to take control.
   */
  reload() {
    window.location.reload()
  }
}

window.SuClient = SuClient
export { SuClient }
