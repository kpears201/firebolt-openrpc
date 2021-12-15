import { default as win } from '../Transport/global'

const MAX_QUEUED_MESSAGES = 100
const DEFAULT_SESSION_ENDPOINT = 'http://localhost:3473/session/'

export default class WebsocketTransport {
  constructor (apiEndpoint) {
    this._ws = null
    this._connected = false
    this._queue = []
    this._callbacks = []
    this._connecting = false
    this._apiEndpoint = apiEndpoint
  }

  send (msg) {
    this._connect()

    if (this._connected) {
      this._ws.send(msg)
    } else {
      if (this._queue.length < MAX_QUEUED_MESSAGES) {
        this._queue.push(msg)
      }
    }
  }

  receive (callback) {
    if (!callback) return
    this._connect()
    this._callbacks.push(callback)
  }

  _notifyCallbacks (message) {
    for (let i = 0; i < this._callbacks.length; i++) {
      setTimeout(() => this._callbacks[i](message), 1)
    }
  }

  _connect () {
    if (this._ws || this._connecting) return
    this._connecting = true
    this._configureWs(this._apiEndpoint)
  }

  _configureWs (url) {
    this._ws = new WebSocket(url)
    this._ws.addEventListener('message', message => {
      this._notifyCallbacks(message.data)
    })
    this._ws.addEventListener('error', message => {
    })
    this._ws.addEventListener('close', message => {
      this._ws = null
      this._connected = false
      this._connecting = false
    })
    this._ws.addEventListener('open', message => {
      this._connecting = false
      this._connected = true
      for (let i = 0; i < this._queue.length; i++) {
        this._ws.send(this._queue[i])
      }
      this._queue = []
    })
  }

  /**
   * Checks these locations for apiEndpoint:
   * queryParameter "_apiEndpoint"
   * global variable _apiEndpoint
   * session object obtained by querying session service
   * @returns The apiEndpoint uri to the websocket
   */
  static async discoverApiEndpoint () {
    const apiEndpoint = new URLSearchParams(win.location.search).get('_apiEndpoint')
    if (apiEndpoint) return apiEndpoint
    if (win._apiEndpoint) return win._apiEndpoint
    try {
      const resp = await WebsocketTransport.fetchSession()
      return resp.apiEndpoint
    } catch (err) {
      // session service might just not be available on this platform, SDK will try other transports
    }
    return null
  }

  static async fetchSession () {
    let sessionEndpoint = new URLSearchParams(win.location.search).get('_sessionEndpoint')
    const resp = await fetch(sessionEndpoint || DEFAULT_SESSION_ENDPOINT, {
      method: 'POST'
    })
    return await resp.json()
  }

}