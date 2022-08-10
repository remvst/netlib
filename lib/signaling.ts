import { EventEmitter } from 'eventemitter3'
import Network from './network'
import Peer from './peer'
import { SignalingPacketTypes } from './types'

interface SignalingListeners {
  credentials: (data: SignalingPacketTypes) => void | Promise<void>
}

export default class Signaling extends EventEmitter<SignalingListeners> {
  private readonly url: string
  private ws: WebSocket
  private reconnectAttempt: number = 0
  private reconnecting: boolean = false
  receivedID?: string
  currentLobby?: string

  private readonly connections: Map<string, Peer>

  private readonly replayQueue: Map<string, SignalingPacketTypes[]>

  constructor (private readonly network: Network, peers: Map<string, Peer>, url: string) {
    super()

    this.url = url
    this.connections = peers
    this.replayQueue = new Map()

    this.ws = this.connect()
  }

  private connect (): WebSocket {
    const ws = new WebSocket(this.url)
    const onOpen = (): void => {
      this.reconnectAttempt = 0
      this.reconnecting = false
      this.send({
        type: 'hello',
        game: this.network.gameID,
        id: this.receivedID
      })
    }
    const onError = (e: Event): void => {
      const error = new SignalingError('socket-error', 'unexpected websocket error', e)
      this.network.emit('signalingerror', error)
      if (this.network.listenerCount('signalingerror') === 0) {
        console.error('signallingerror not handled:', error)
      }
      if (ws.readyState === WebSocket.CLOSED) {
        this.reconnecting = false
        this.reconnect()
      }
    }
    const onMessage = (ev: MessageEvent): void => {
      this.handleSignalingMessage(ev.data).catch(_ => {})
    }
    const onClose = (): void => {
      if (!this.network.closing) {
        const error = new SignalingError('socket-error', 'signaling socket closed')
        this.network.emit('signalingerror', error)
        if (this.network.listenerCount('signalingerror') === 0) {
          console.error('signallingerror not handled:', error)
        }
      }
      ws.removeEventListener('open', onOpen)
      ws.removeEventListener('error', onError)
      ws.removeEventListener('message', onMessage)
      ws.removeEventListener('close', onClose)
      this.reconnect()
    }
    ws.addEventListener('open', onOpen)
    ws.addEventListener('error', onError)
    ws.addEventListener('message', onMessage)
    ws.addEventListener('close', onClose)
    return ws
  }

  private reconnect (): void {
    if (this.reconnecting || this.network.closing) {
      return
    }
    if (this.reconnectAttempt > 42) {
      this.network.emit('failed')
      this.network.emit('signalingerror', new SignalingError('socket-error', 'giving up on reconnecting to signaling server'))
      return
    }
    void this.event('signaling', 'attempt-reconnect')
    this.reconnecting = true
    setTimeout(() => {
      this.ws = this.connect()
    }, Math.random() * 100 * this.reconnectAttempt)
    this.reconnectAttempt += 1
  }

  close (): void {
    this.ws.close()
  }

  send (packet: SignalingPacketTypes): void {
    if (this.ws.readyState === WebSocket.CONNECTING || this.ws.readyState === WebSocket.OPEN) {
      this.network.log('sending signaling packet:', packet.type)
      const data = JSON.stringify(packet)
      this.ws.send(data)
    }
  }

  private async handleSignalingMessage (data: string): Promise<void> {
    try {
      const packet = JSON.parse(data) as SignalingPacketTypes
      this.network.log('signaling packet received:', packet.type)
      switch (packet.type) {
        case 'error':
          {
            const error = new SignalingError('server-error', packet.error)
            this.network.emit('signalingerror', error)
            if (this.network.listenerCount('signalingerror') === 0) {
              console.error('signallingerror not handled:', error)
            }
          }
          break

        case 'welcome':
          if (this.receivedID !== undefined) {
            this.network.log('signaling reconnected')
            this.network.emit('signalingreconnected')
            return
          }
          if (packet.id === '') {
            throw new Error('missing id on received welcome packet')
          }
          this.receivedID = packet.id
          this.network.emit('ready')
          this.network._prefetchTURNCredentials()
          break

        case 'joined':
          if (packet.lobby === '') {
            throw new Error('missing lobby on received connect packet')
          }
          this.currentLobby = packet.lobby
          this.network.emit('lobby', packet.lobby)
          break

        case 'connect':
          if (this.receivedID === packet.id) {
            return // Skip self
          }
          await this.network._addPeer(packet.id, packet.polite)
          for (const p of this.replayQueue.get(packet.id) ?? []) {
            await this.connections.get(packet.id)?._onSignalingMessage(p)
          }
          this.replayQueue.delete(packet.id)
          break
        case 'disconnect':
          if (this.connections.has(packet.id)) {
            this.connections.get(packet.id)?.close()
          }
          break

        case 'candidate':
        case 'description':
          if (this.connections.has(packet.source)) {
            await this.connections.get(packet.source)?._onSignalingMessage(packet)
          } else {
            const queue = this.replayQueue.get(packet.source) ?? []
            queue.push(packet)
            this.replayQueue.set(packet.source, queue)
          }
          break
        case 'credentials':
          this.emit('credentials', packet)
          break
      }
    } catch (e) {
      const error = new SignalingError('unknown-error', e as string)
      this.network.emit('signalingerror', error)
    }
  }

  async event (category: string, action: string, data?: {[key: string]: string}): Promise<void> {
    return await new Promise(resolve => {
      setTimeout(() => {
        this.send({
          type: 'event',
          game: this.network.gameID,
          lobby: this.currentLobby,
          peer: this.network.id,
          category,
          action,
          data
        })
        resolve()
      }, 0)
    })
  }
}

export class SignalingError {
  constructor (public type: 'unknown-error' | 'socket-error' | 'server-error', public message: string, public event?: Event) {}
  public toString (): string {
    return `[${this.type}: ${this.message}]`
  }
}
