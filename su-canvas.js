/**
 * SuCanvas - Multi-tab manager for SuClient instances.
 * Acts as the "Virtual Browser" controller.
 */
class SuCanvas {
  /**
   * Available events.
   * @readonly
   */
  static get EVENTS() {
    return {
      SURFACE_CREATED: 'surfaceCreated',
      SURFACE_CHANGE: 'surfaceChange',
      SURFACE_CLOSED: 'surfaceClosed',
      SURFACE_UPDATE: 'surfaceUpdate',
      // Proxied events from active SuClient
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
   * Creates an instance of SuCanvas.
   * @param {string|HTMLElement} containerId - The container element.
   */
  constructor(containerId) {
    this.container = typeof containerId === 'string' 
      ? document.getElementById(containerId) 
      : containerId;
    
    if (!this.container) throw new Error('Container element not found');

    this.surfaces = new Map(); // id -> { id, client, iframe }
    this.activeSurfaceId = null;
    this.listeners = {};
  }

  /**
   * Creates a new browsing surface (tab).
   * @param {string} [url='about:blank'] - Initial URL.
   * @returns {string} The ID of the new surface.
   */
  createSurface(url = 'about:blank') {
    const id = 'surface-' + Math.random().toString(36).substr(2, 9);
    
    // Create iframe
    const iframe = document.createElement('iframe');
    iframe.id = id;
    iframe.style.width = '100%';
    iframe.style.height = '100%';
    iframe.style.border = 'none';
    iframe.style.display = 'none'; // Hidden by default
    iframe.style.backgroundColor = 'transparent';
    
    this.container.appendChild(iframe);

    // Initialize Client
    const client = new SuClient({ frame: iframe });
    
    // Proxy events from the active client to the canvas
    this._bindSurfaceEvents(id, client);

    const surface = {
      id,
      iframe,
      client,
      title: 'New Tab',
      favicon: ''
    };

    this.surfaces.set(id, surface);
    
    // Initialize the client
    client.init().then(() => {
        if (url && url !== 'about:blank') {
            client.navigate(url);
        }
    });

    this.emit(SuCanvas.EVENTS.SURFACE_CREATED, surface);

    // Auto-switch if it's the first one
    if (this.surfaces.size === 1) {
      this.switchSurface(id);
    }

    return id;
  }

  /**
   * Switches the active view to the specified surface.
   * @param {string} id - The surface ID.
   */
  switchSurface(id) {
    if (!this.surfaces.has(id)) return;

    // Hide current
    if (this.activeSurfaceId && this.surfaces.has(this.activeSurfaceId)) {
      this.surfaces.get(this.activeSurfaceId).iframe.style.display = 'none';
    }

    // Show new
    const surface = this.surfaces.get(id);
    surface.iframe.style.display = 'block';
    this.activeSurfaceId = id;

    this.emit(SuCanvas.EVENTS.SURFACE_CHANGE, surface);
    
    // Re-emit state for UI updates
    const state = surface.client.getState();
    this.emit(SuCanvas.EVENTS.STATUS_CHANGE, state);

    // Sync loading spinner state
    if (state.loading) {
        this.emit(SuCanvas.EVENTS.LOADING_START);
    } else {
        this.emit(SuCanvas.EVENTS.LOADING_STOP);
    }
  }

  /**
   * Closes a surface.
   * @param {string} id - The surface ID.
   */
  closeSurface(id) {
    if (!this.surfaces.has(id)) return;

    const surface = this.surfaces.get(id);
    
    // Cleanup DOM
    surface.iframe.remove();
    this.surfaces.delete(id);

    this.emit(SuCanvas.EVENTS.SURFACE_CLOSED, id);

    // Switch to another tab if we closed the active one
    if (this.activeSurfaceId === id) {
      this.activeSurfaceId = null;
      if (this.surfaces.size > 0) {
        const nextId = this.surfaces.keys().next().value;
        this.switchSurface(nextId);
      } else {
        this.emit(SuCanvas.EVENTS.SURFACE_CHANGE, null); // No tabs left
      }
    }
  }

  /**
   * Gets the currently active surface object.
   */
  get activeSurface() {
    return this.activeSurfaceId ? this.surfaces.get(this.activeSurfaceId) : null;
  }

  /**
   * Proxy method to navigate the active surface.
   */
  navigate(url) {
    if (this.activeSurface) {
      return this.activeSurface.client.navigate(url);
    }
  }

  goBack() { this.activeSurface?.client.goBack(); }
  goForward() { this.activeSurface?.client.goForward(); }
  reload() { this.activeSurface?.client.reloadFrame(); }

  /**
   * Internal event binding.
   */
  _bindSurfaceEvents(id, client) {
    // Notify general updates regardless of active state
    const notifyUpdate = () => {
        const surface = this.surfaces.get(id);
        if (surface) this.emit(SuCanvas.EVENTS.SURFACE_UPDATE, surface);
    };

    // We only bubble specific events if they come from the ACTIVE surface
    const bubble = (event, data) => {
      if (this.activeSurfaceId === id) {
        this.emit(event, data);
      }
    };

    client.on(SuClient.EVENTS.NAVIGATING, d => bubble(SuCanvas.EVENTS.NAVIGATING, d));
    client.on(SuClient.EVENTS.URL_CHANGE, d => bubble(SuCanvas.EVENTS.URL_CHANGE, d));
    
    client.on(SuClient.EVENTS.TITLE_CHANGE, d => {
        const surface = this.surfaces.get(id);
        if (surface) surface.title = d;
        notifyUpdate();
        bubble(SuCanvas.EVENTS.TITLE_CHANGE, d);
    });

    client.on(SuClient.EVENTS.FAVICON_CHANGE, d => {
        const surface = this.surfaces.get(id);
        if (surface) surface.favicon = d;
        notifyUpdate();
        bubble(SuCanvas.EVENTS.FAVICON_CHANGE, d);
    });

    client.on(SuClient.EVENTS.STATUS_CHANGE, d => bubble(SuCanvas.EVENTS.STATUS_CHANGE, d));
    
    client.on(SuClient.EVENTS.LOADING_START, d => {
        notifyUpdate();
        bubble(SuCanvas.EVENTS.LOADING_START, d);
    });
    
    client.on(SuClient.EVENTS.LOADING_STOP, d => {
        notifyUpdate();
        bubble(SuCanvas.EVENTS.LOADING_STOP, d);
    });

    client.on(SuClient.EVENTS.READY, d => bubble(SuCanvas.EVENTS.READY, d));
    client.on(SuClient.EVENTS.ERROR, d => bubble(SuCanvas.EVENTS.ERROR, d));
  }

  on(event, callback) {
    if (!this.listeners[event]) this.listeners[event] = [];
    this.listeners[event].push(callback);
  }

  emit(event, data) {
    if (!this.listeners[event]) return;
    this.listeners[event].forEach(cb => cb(data));
  }
}

window.SuCanvas = SuCanvas;
export { SuCanvas };
