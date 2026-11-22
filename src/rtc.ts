import type { Hass } from "./types";

/**
 * Collegamento WebRTC con una telecamera attraverso le API websocket pubbliche di Home Assistant
 * (`camera/webrtc/get_client_config`, `camera/webrtc/offer`, `camera/webrtc/candidate`): le stesse usate dal lettore nativo.
 * Con un microfono l'audio viene negoziato in entrambe le direzioni (sendrecv) fin dall'offerta: i provider (go2rtc)
 * non gestiscono bene la rinegoziazione, quindi per aggiungere il microfono a una sessione che non lo aveva se ne apre una nuova.
 */
export interface RtcHandlers {
  onStream(stream: MediaStream): void;
  onState(state: string): void;
  onError(message: string): void;
}

export interface RtcLike {
  readonly hasMicSender: boolean;
  start(): Promise<void>;
  setMic(track: MediaStreamTrack | null): Promise<void>;
  stop(): void;
}

type OfferEvent =
  | { type: "session"; session_id: string }
  | { type: "answer"; answer: string }
  | { type: "candidate"; candidate: RTCIceCandidateInit }
  | { type: "error"; code: string; message: string };

/** Il browser permette di usare il microfono solo in un contesto sicuro (HTTPS o localhost). */
export const micSupported = (): boolean =>
  typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia && (typeof window === "undefined" || window.isSecureContext !== false);

/** Chiede il microfono con la cancellazione dell'eco e la riduzione del rumore del browser. */
export async function getMic(): Promise<MediaStreamTrack> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
  const track = stream.getAudioTracks()[0];
  if (!track) throw new Error("no_audio_track");
  return track;
}

export class RtcSession implements RtcLike {
  private pc?: RTCPeerConnection;
  private unsub?: () => void | Promise<void>;
  private sessionId?: string;
  private pending: RTCIceCandidateInit[] = [];
  private sender?: RTCRtpSender;
  private closed = false;
  private stream?: MediaStream;

  constructor(private hass: Hass, private entityId: string, private mic: MediaStreamTrack | null, private handlers: RtcHandlers) {}

  get hasMicSender(): boolean { return !!this.sender; }

  async start(): Promise<void> {
    const client = await this.hass.callWS<{ configuration?: RTCConfiguration; dataChannel?: string }>({ type: "camera/webrtc/get_client_config", entity_id: this.entityId });
    if (this.closed) return;
    const pc = (this.pc = new RTCPeerConnection(client.configuration ?? {}));
    if (client.dataChannel) pc.createDataChannel(client.dataChannel);
    if (this.mic) this.sender = pc.addTransceiver(this.mic, { direction: "sendrecv" }).sender;
    else pc.addTransceiver("audio", { direction: "recvonly" });
    pc.addTransceiver("video", { direction: "recvonly" });
    this.stream = new MediaStream();
    pc.ontrack = (ev) => {
      if (this.closed || !this.stream) return;
      this.stream.addTrack(ev.track);
      this.handlers.onStream(this.stream);
    };
    pc.onconnectionstatechange = () => { if (!this.closed) this.handlers.onState(pc.connectionState); };
    pc.onicecandidate = (ev) => {
      if (!ev.candidate || this.closed) return;
      const candidate = ev.candidate.toJSON();
      if (this.sessionId) this.sendCandidate(candidate);
      else this.pending.push(candidate);
    };
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    if (this.closed) return;
    const unsub = await this.hass.connection.subscribeMessage<OfferEvent>((ev) => this.onEvent(ev), { type: "camera/webrtc/offer", entity_id: this.entityId, offer: offer.sdp });
    if (this.closed) void unsub();
    else this.unsub = unsub;
  }

  private onEvent(ev: OfferEvent): void {
    if (this.closed || !this.pc) return;
    if (ev.type === "session") {
      this.sessionId = ev.session_id;
      for (const c of this.pending.splice(0)) this.sendCandidate(c);
    } else if (ev.type === "answer") {
      this.pc.setRemoteDescription({ type: "answer", sdp: ev.answer }).catch((err) => this.handlers.onError(String(err?.message ?? err)));
    } else if (ev.type === "candidate") {
      this.pc.addIceCandidate(ev.candidate).catch(() => { /* candidato non valido per questo collegamento: si ignora */ });
    } else if (ev.type === "error") {
      this.handlers.onError(ev.message || ev.code);
    }
  }

  private sendCandidate(candidate: RTCIceCandidateInit): void {
    this.hass.callWS({ type: "camera/webrtc/candidate", entity_id: this.entityId, session_id: this.sessionId, candidate }).catch(() => { /* la sessione puo' essere gia' chiusa */ });
  }

  /** Accende o spegne il microfono su una sessione nata con il microfono. */
  async setMic(track: MediaStreamTrack | null): Promise<void> {
    if (!this.sender) return;
    this.mic = track;
    await this.sender.replaceTrack(track);
  }

  stop(): void {
    if (this.closed) return;
    this.closed = true;
    try { void this.unsub?.(); } catch { /* collegamento gia' chiuso */ }
    this.unsub = undefined;
    if (this.pc) {
      this.pc.ontrack = null;
      this.pc.onicecandidate = null;
      this.pc.onconnectionstatechange = null;
      this.pc.close();
      this.pc = undefined;
    }
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = undefined;
  }
}

/** Le pagine di prova possono sostituire il collegamento e il microfono con dei finti (window.__videocitofonoRtc / __videocitofonoMic). */
export function createSession(hass: Hass, entityId: string, mic: MediaStreamTrack | null, handlers: RtcHandlers): RtcLike {
  const fake = (globalThis as any).__videocitofonoRtc as ((...args: unknown[]) => RtcLike) | undefined;
  return fake ? fake(hass, entityId, mic, handlers) : new RtcSession(hass, entityId, mic, handlers);
}

export function acquireMic(): Promise<MediaStreamTrack> {
  const fake = (globalThis as any).__videocitofonoMic as (() => Promise<MediaStreamTrack>) | undefined;
  return fake ? fake() : getMic();
}

export function canUseMic(): boolean {
  return (globalThis as any).__videocitofonoMic ? true : micSupported();
}
