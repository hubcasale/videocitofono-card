import { LitElement, css, html, nothing } from "lit";
import type { PropertyValues, TemplateResult } from "lit";
import { normalize } from "./config";
import type { CardConfig, Settings } from "./config";
import { strings } from "./i18n";
import type { Strings } from "./i18n";
import { armLeft, armed, changedMs, domainOf, doorService, fmtClock, isRinging, recentRing, ringTriggered } from "./logic";
import { RECENT_MS, overlayOpen, popupManaged, startWatcher, syncPopupConfig } from "./overlay";
import { acquireMic, canUseMic, createSession } from "./rtc";
import type { RtcLike } from "./rtc";
import type { Hass, HassState, MicState } from "./types";
import "./editor";

const VERSION = "0.1.1";
/** Tempo di pressione per aprire la porta in modalita' "tieni premuto". */
const HOLD_MS = 1500;
/** Dopo l'apertura della porta la chiamata resta ancora qualche secondo, il tempo di un saluto. */
const END_AFTER_OPEN_MS = 8000;
const SNAPSHOT_MS = 10_000;
const RING_BANNER_MS = 20_000;
const RETRY_MS = 15_000;
/** Se dopo questo tempo il video non ha ancora un fotogramma, il dispositivo non riesce a decodificarlo. */
const FRAME_WAIT_MS = 7000;
/** Telecamere per cui questo dispositivo usa direttamente quella di riserva (con la data: dopo un mese si riprova la principale). */
const LIGHT_KEY = "videocitofono-card.light";
const LIGHT_DAYS = 30;
/** Pacchetti video ricevuti oltre i quali "nessun fotogramma" vuol dire che il dispositivo non decodifica il flusso. */
const STUCK_PACKETS = 30;

/**
 * Scheda del videocitofono: video dal vivo e audio bidirezionale nativi di Home Assistant, avvio automatico alla suonata,
 * pulsante apriporta con conferma. Con `overlay` la scheda occupa tutto lo schermo ed emette `videocitofono-close` a fine chiamata.
 */
export class VideocitofonoCard extends LitElement {
  static properties = {
    hass: { attribute: false },
    overlay: { type: Boolean, reflect: true },
    _config: { state: true }, _call: { state: true }, _connecting: { state: true }, _hasVideo: { state: true }, _error: { state: true },
    _micState: { state: true }, _micOn: { state: true }, _talking: { state: true }, _speaker: { state: true }, _needsGesture: { state: true },
    _armUntil: { state: true }, _holding: { state: true }, _doorMsg: { state: true }, _now: { state: true }, _twoWay: { state: true }, _snapN: { state: true }, _noFrames: { state: true },
  };

  declare hass?: Hass;
  declare overlay: boolean;
  declare _config: CardConfig | null;
  declare _call: boolean;
  declare _connecting: boolean;
  declare _hasVideo: boolean;
  declare _error: string;
  declare _micState: MicState;
  declare _micOn: boolean;
  declare _talking: boolean;
  declare _speaker: boolean;
  declare _needsGesture: boolean;
  declare _armUntil: number;
  declare _holding: boolean;
  declare _doorMsg: "" | "done" | "error";
  declare _now: number;
  declare _twoWay: boolean | undefined;
  declare _snapN: number;
  declare _noFrames: boolean;

  private _s: Settings = normalize(null);
  private _session?: RtcLike;
  private _stream?: MediaStream;
  private _mic?: MediaStreamTrack;
  private _epoch = 0;
  private _callEnds = 0;
  private _ringAt = 0;
  private _ringChecked = false;
  private _synced = false;
  private _capsFor = "";
  private _timer?: number;
  private _snapTimer?: number;
  private _holdTimer?: number;
  private _doorMsgUntil = 0;
  private _retryAt = 0;
  private _wantTalk = false;
  private _useFallback = false;
  private _frameTimer?: number;

  constructor() {
    super();
    this.overlay = false;
    this._config = null;
    this._call = false; this._connecting = false; this._hasVideo = false; this._error = "";
    this._micState = "off"; this._micOn = false; this._talking = false; this._speaker = true; this._needsGesture = false;
    this._armUntil = 0; this._holding = false; this._doorMsg = ""; this._now = 0; this._twoWay = undefined; this._snapN = 0; this._noFrames = false;
  }

  static getConfigElement(): HTMLElement { return document.createElement("videocitofono-card-editor"); }

  static getStubConfig(hass: Hass): CardConfig {
    const ids = Object.keys(hass?.states ?? {});
    const first = (domain: string) => ids.find((id) => id.startsWith(`${domain}.`)) ?? "";
    return { camera: first("camera"), door: first("lock") };
  }

  setConfig(config: CardConfig): void {
    if (!config || typeof config !== "object") throw new Error("Configurazione non valida");
    const before = this._s;
    this._config = config;
    this._s = normalize(config);
    this._synced = false;
    if (before.camera !== this._s.camera || before.camera_fallback !== this._s.camera_fallback) this._useFallback = false;
    if (before.camera !== this._s.camera) { this._twoWay = undefined; this._capsFor = ""; if (!this._call) this._dropSession(); }
    if (before.ring !== this._s.ring) this._ringChecked = false;
  }

  getCardSize(): number { return 7; }
  getGridOptions(): Record<string, unknown> { return { columns: 12, min_columns: 6, min_rows: 5 }; }

  /** Il campanello ha suonato: usata dalla finestra automatica, che decide da sola quando aprire la chiamata. */
  ring(): void {
    this._ringAt = Date.now();
    this._beginOrExtend();
  }

  connectedCallback(): void {
    super.connectedCallback();
    startWatcher();
    this._snapTimer = window.setInterval(() => { if (!this._call && this._s.idle === "snapshot") this._snapN++; }, SNAPSHOT_MS);
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this._epoch++;
    this._call = false;
    this._callEnds = 0;
    this._releaseMic();
    this._dropSession();
    this._connecting = false;
    if (this._timer !== undefined) { clearInterval(this._timer); this._timer = undefined; }
    if (this._snapTimer !== undefined) { clearInterval(this._snapTimer); this._snapTimer = undefined; }
    if (this._holdTimer !== undefined) { clearTimeout(this._holdTimer); this._holdTimer = undefined; }
  }

  protected willUpdate(changed: PropertyValues): void {
    if (!this.hass || !this._config) return;
    const s = this._s;
    if (changed.has("hass") || changed.has("_config")) {
      const prev = changed.get("hass") as Hass | undefined;
      if (s.ring) {
        const now = this.hass.states[s.ring];
        if (!this._ringChecked) {
          this._ringChecked = true;
          if (recentRing(domainOf(s.ring), now?.state, changedMs(now), Date.now(), RECENT_MS)) this._ringSoon();
        } else if (prev) {
          const before = prev.states[s.ring];
          if (before !== now && ringTriggered(before?.state, now?.state, domainOf(s.ring))) this._ringSoon();
        }
      }
      // la porta si e' aperta durante la chiamata (dal pulsante o in altro modo): la chiamata si chiude poco dopo
      if (prev && this._call && s.end_on_open && s.door_sensor) {
        const before = prev.states[s.door_sensor]?.state, now = this.hass.states[s.door_sensor]?.state;
        if (before === "off" && now === "on") this._shortenCall();
      }
      if (!this.overlay && !this._synced) { this._synced = true; syncPopupConfig(this._config, this.hass); }
      if (s.camera && this._capsFor !== s.camera) { this._capsFor = s.camera; void this._loadCaps(s.camera); }
    }
  }

  protected updated(): void {
    this._syncVideo();
    this._syncLive();
  }

  private _t(): Strings { return strings(this.hass?.locale?.language ?? this.hass?.language); }

  private async _loadCaps(camera: string): Promise<void> {
    try {
      const caps = await this.hass!.callWS<{ two_way_audio?: boolean }>({ type: "camera/capabilities", entity_id: camera });
      if (this._s.camera === camera) this._twoWay = caps?.two_way_audio === true;
    } catch { /* versione senza questo comando: si prova comunque */ }
  }

  // ---------------------------------------------------------------- suonata

  private _ringSoon(): void { queueMicrotask(() => this._onRing()); }

  private _onRing(): void {
    this._ringAt = Date.now();
    this._tick();
    if (this.overlay) { this._beginOrExtend(); return; }
    // con la finestra automatica attiva su questo dispositivo la chiamata si apre li', non nella pagina
    if (popupManaged(this._config, this.hass) || overlayOpen()) return;
    if (this._s.auto_call) this._beginOrExtend();
  }

  private _beginOrExtend(): void {
    if (this._call) {
      if (this._s.call_seconds > 0) this._callEnds = Date.now() + this._s.call_seconds * 1000;
    } else void this._startCall(this._s.auto_talk);
  }

  // ---------------------------------------------------------------- chiamata

  private async _startCall(talk: boolean): Promise<void> {
    if (!this.hass || !this._s.camera || this._call) return;
    const s = this._s;
    this._call = true;
    this._speaker = true;
    this._needsGesture = false;
    this._error = "";
    this._micState = "off";
    this._callEnds = s.call_seconds > 0 ? Date.now() + s.call_seconds * 1000 : 0;
    this._tick();
    const epoch = ++this._epoch;
    let track: MediaStreamTrack | null = null;
    // "tieni premuto": il microfono si prende subito (spento), cosi' alla pressione si parla senza attese
    if ((talk || s.talk_mode === "hold") && this._twoWay !== false) track = await this._getMic();
    if (epoch !== this._epoch || !this._call) { track?.stop(); return; }
    if (track && s.talk_mode === "hold") track.enabled = false;
    this._micOn = !!track && s.talk_mode === "open";
    await this._connect(track);
  }

  private _endCall = (): void => {
    this._epoch++;
    this._call = false;
    this._callEnds = 0;
    this._needsGesture = false;
    this._releaseMic();
    this._dropSession();
    this._connecting = false;
    if (this.overlay) this.dispatchEvent(new CustomEvent("videocitofono-close", { bubbles: true, composed: true }));
  };

  private _shortenCall(): void {
    const soon = Date.now() + END_AFTER_OPEN_MS;
    this._callEnds = this._callEnds ? Math.min(this._callEnds, soon) : soon;
  }

  /** Telecamera in uso: quella di riserva se su questo dispositivo la principale non ha mostrato il video. */
  private _camera(): string {
    return this._useFallback && this._s.camera_fallback ? this._s.camera_fallback : this._s.camera;
  }

  private _lightCameras(): Record<string, number> {
    try {
      const saved = JSON.parse(localStorage.getItem(LIGHT_KEY) ?? "{}");
      const out: Record<string, number> = {};
      if (saved && typeof saved === "object" && !Array.isArray(saved)) {
        for (const [camera, at] of Object.entries(saved)) if (typeof at === "number" && Date.now() - at < LIGHT_DAYS * 86_400_000) out[camera] = at;
      }
      return out;
    } catch { return {}; }
  }

  private _rememberLight(): void {
    try { localStorage.setItem(LIGHT_KEY, JSON.stringify({ ...this._lightCameras(), [this._s.camera]: Date.now() })); }
    catch { /* senza localStorage si riprova a ogni chiamata */ }
  }

  /**
   * Alcuni dispositivi non decodificano i flussi ad alta risoluzione (un iPhone con un H.264 da 5 megapixel): l'audio arriva
   * ma il video resta nero. Se dopo qualche secondo i pacchetti video arrivano ma nessun fotogramma viene decodificato si passa
   * alla telecamera di riserva, e il dispositivo se lo ricorda per le chiamate successive.
   * Con la pagina in secondo piano il browser puo' non decodificare nulla: in quel caso si aspetta.
   */
  private _watchFrames(session: RtcLike): void {
    if (this._frameTimer !== undefined) return;
    this._frameTimer = window.setTimeout(async () => {
      this._frameTimer = undefined;
      if (this._session !== session) return;
      if (document.visibilityState !== "visible") { this._watchFrames(session); return; }
      const video = this.renderRoot.querySelector("video") as HTMLVideoElement | null;
      if (!video || video.videoWidth > 0) return;
      const stats = session.videoStats ? await session.videoStats().catch(() => null) : null;
      if (this._session !== session) return;
      // senza pacchetti il problema e' il collegamento, non la decodifica: cambiare telecamera non servirebbe
      if (stats && !(stats.packets > STUCK_PACKETS && stats.decoded === 0)) { if (stats.packets > STUCK_PACKETS) return; this._watchFrames(session); return; }
      if (!this._useFallback && this._s.camera_fallback) {
        this._useFallback = true;
        this._rememberLight();
        const mic = this._mic && (this._micOn || this._s.talk_mode === "hold") ? this._mic : null;
        void this._connect(mic);
      } else this._noFrames = true;
    }, FRAME_WAIT_MS);
  }

  private async _connect(mic: MediaStreamTrack | null): Promise<void> {
    this._dropSession();
    if (!this.hass || !this._s.camera) return;
    if (!this._useFallback && this._s.camera_fallback && this._lightCameras()[this._s.camera]) this._useFallback = true;
    this._connecting = true;
    this._error = "";
    this._noFrames = false;
    const session: RtcLike = createSession(this.hass, this._camera(), mic, {
      onStream: (stream) => {
        if (this._session !== session) return;
        this._stream = stream;
        this._hasVideo = true;
        this._connecting = false;
        this._watchFrames(session);
        this.requestUpdate();
      },
      onState: (state) => {
        if (this._session !== session) return;
        if (state === "connected") this._connecting = false;
        if (state === "failed") this._failed(session, "");
      },
      onError: (message) => this._failed(session, message),
    });
    this._session = session;
    try { await session.start(); } catch (err) { this._failed(session, String((err as Error)?.message ?? err)); }
  }

  private _failed(session: RtcLike, message: string): void {
    if (this._session !== session) return;
    this._dropSession();
    this._connecting = false;
    this._error = message || "stream";
    this._retryAt = Date.now() + RETRY_MS;
  }

  private _dropSession(): void {
    if (this._frameTimer !== undefined) { clearTimeout(this._frameTimer); this._frameTimer = undefined; }
    this._session?.stop();
    this._session = undefined;
    this._stream = undefined;
    this._hasVideo = false;
  }

  /** A riposo, con "video dal vivo", la scheda tiene aperto un collegamento senza microfono e senza audio. */
  private _syncLive(): void {
    const want = !this._call && !this.overlay && this._s.idle === "live" && !!this.hass && !!this._s.camera && this.isConnected && !overlayOpen();
    if (want && !this._session && !this._connecting && Date.now() >= this._retryAt) queueMicrotask(() => { if (!this._session && !this._call) void this._connect(null); });
    else if (!want && !this._call && this._session) queueMicrotask(() => { if (!this._call) { this._dropSession(); this._connecting = false; } });
  }

  private _audioOn(): boolean {
    return this._call && this._speaker && !this._needsGesture && !(this._s.talk_mode === "hold" && this._talking);
  }

  private _syncVideo(): void {
    const video = this.renderRoot.querySelector("video") as HTMLVideoElement | null;
    if (!video) return;
    const stream = this._stream ?? null;
    const muted = !this._audioOn();
    let replay = false;
    if (video.srcObject !== stream) { video.srcObject = stream; replay = true; }
    if (video.muted !== muted) { video.muted = muted; replay = true; }
    if (replay && stream) {
      const attempt = video.play();
      // senza un tocco dell'utente il browser puo' rifiutare l'audio: il video parte muto e si chiede un tocco
      if (attempt?.catch) attempt.catch(() => { if (!video.muted && this._call) this._needsGesture = true; });
    }
  }

  private _enableAudio = (): void => { this._needsGesture = false; };
  private _toggleSpeaker = (): void => { this._speaker = !this._speaker; };
  private _watch = (): void => { void this._startCall(false); };

  // ---------------------------------------------------------------- microfono

  private async _getMic(): Promise<MediaStreamTrack | null> {
    if (!canUseMic()) { this._micState = "unavailable"; return null; }
    this._micState = "starting";
    try {
      const track = await acquireMic();
      this._mic = track;
      this._micState = "on";
      return track;
    } catch (err) {
      const name = (err as Error)?.name;
      this._micState = name === "NotAllowedError" || name === "SecurityError" ? "denied" : "error";
      return null;
    }
  }

  private _releaseMic(): void {
    this._mic?.stop();
    this._mic = undefined;
    this._micOn = false;
    this._talking = false;
    this._wantTalk = false;
    if (this._micState === "on" || this._micState === "starting") this._micState = "off";
  }

  /** Attacca il microfono al collegamento: se la sessione non lo prevedeva se ne apre una nuova. */
  private async _attachMic(track: MediaStreamTrack): Promise<void> {
    if (this._session?.hasMicSender) await this._session.setMic(track);
    else await this._connect(track);
  }

  private _toggleMic = async (): Promise<void> => {
    if (!this._call) return;
    if (this._micOn) {
      this._micOn = false;
      void this._session?.setMic(null);
      this._mic?.stop();
      this._mic = undefined;
      this._micState = "off";
      return;
    }
    const epoch = this._epoch;
    const track = await this._getMic();
    if (!track) return;
    if (epoch !== this._epoch || !this._call) { track.stop(); this._mic = undefined; return; }
    await this._attachMic(track);
    this._micOn = true;
  };

  private _talkDown = async (ev: PointerEvent): Promise<void> => {
    ev.preventDefault();
    if (!this._call) return;
    (ev.currentTarget as HTMLElement).setPointerCapture?.(ev.pointerId);
    this._wantTalk = true;
    if (!this._mic) {
      const epoch = this._epoch;
      const track = await this._getMic();
      if (!track) return;
      if (epoch !== this._epoch || !this._call) { track.stop(); this._mic = undefined; return; }
      track.enabled = false;
      await this._attachMic(track);
    }
    if (this._mic && this._wantTalk) { this._mic.enabled = true; this._talking = true; }
  };

  private _talkUp = (): void => {
    this._wantTalk = false;
    if (this._mic) this._mic.enabled = false;
    this._talking = false;
  };

  // ---------------------------------------------------------------- porta

  private _doorClick = (): void => {
    if (this._s.confirm !== "tap") return;
    const now = Date.now();
    if (armed(this._armUntil, now)) { void this._fireDoor(); return; }
    this._armUntil = now + this._s.confirm_seconds * 1000;
    this._doorMsg = "";
    this._tick();
  };

  private _doorDown = (ev: PointerEvent): void => {
    if (this._s.confirm !== "hold") return;
    ev.preventDefault();
    (ev.currentTarget as HTMLElement).setPointerCapture?.(ev.pointerId);
    this._holding = true;
    this._doorMsg = "";
    this._holdTimer = window.setTimeout(() => { this._holdTimer = undefined; this._holding = false; void this._fireDoor(); }, HOLD_MS);
  };

  private _doorUp = (): void => {
    if (this._holdTimer !== undefined) { clearTimeout(this._holdTimer); this._holdTimer = undefined; }
    this._holding = false;
  };

  private async _fireDoor(): Promise<void> {
    this._armUntil = 0;
    const s = this._s;
    const service = this.hass ? doorService(s.door, s.door_action, this.hass.states[s.door]?.attributes?.supported_features) : null;
    try {
      if (!service || !this.hass) throw new Error("no_service");
      await this.hass.callService(service.domain, service.service, {}, { entity_id: s.door });
      this._doorMsg = "done";
      this._doorMsgUntil = Date.now() + 4000;
      if (this._call && s.end_on_open) this._shortenCall();
    } catch {
      this._doorMsg = "error";
      this._doorMsgUntil = Date.now() + 6000;
    }
    this._tick();
  }

  // ---------------------------------------------------------------- orologio

  private _tick(): void {
    this._now = Date.now();
    if (this._timer !== undefined) return;
    this._timer = window.setInterval(() => this._onTick(), 250);
  }

  private _onTick(): void {
    const now = Date.now();
    this._now = now;
    if (this._call && this._callEnds && now >= this._callEnds) this._endCall();
    if (this._armUntil && now >= this._armUntil) this._armUntil = 0;
    if (this._doorMsg && now >= this._doorMsgUntil) this._doorMsg = "";
    const ringShown = this._ringAt > 0 && now - this._ringAt < RING_BANNER_MS;
    if (!this._call && !this._armUntil && !this._doorMsg && !ringShown && this._timer !== undefined) { clearInterval(this._timer); this._timer = undefined; }
  }

  // ---------------------------------------------------------------- disegno

  private _stateText(stateObj: HassState): string {
    return this.hass?.formatEntityState ? this.hass.formatEntityState(stateObj) : stateObj.state;
  }

  private _lockText(t: Strings): string {
    const st = this._s.door && domainOf(this._s.door) === "lock" ? this.hass?.states[this._s.door] : undefined;
    return st ? t(`lock_${st.state}`) || this._stateText(st) : "";
  }

  private _renderStage(t: Strings, cam: HassState | undefined): TemplateResult {
    const s = this._s;
    let center: TemplateResult | typeof nothing = nothing;
    if (!s.camera) center = html`<div class="center">${t("no_camera")}</div>`;
    else if (!cam) center = html`<div class="center">${t("camera_missing")}</div>`;
    else if (this._error && !this._hasVideo) center = html`<div class="center">${t("stream_error")}<small>${this._error === "stream" ? "" : this._error}</small></div>`;
    else if (this._connecting && !this._hasVideo) center = html`<div class="center"><span class="spin"></span>${t("connecting")}</div>`;
    else if (!this._call && s.idle === "snapshot") center = html`<button class="play" @click=${this._watch} aria-label=${t("watch")}><ha-icon icon="mdi:play"></ha-icon></button>`;
    const pic = cam?.attributes?.entity_picture as string | undefined;
    const snapshot = !this._hasVideo && pic && (!this._call || this._connecting)
      ? html`<img alt="" src=${pic.startsWith("data:") ? pic : `${pic}${pic.includes("?") ? "&" : "?"}vc=${this._snapN}`} />` : nothing;
    let toast: TemplateResult | typeof nothing = nothing;
    if (this._call && this._needsGesture) toast = html`<button class="toast tap" @click=${this._enableAudio}><ha-icon icon="mdi:volume-high"></ha-icon>${t("tap_audio")}</button>`;
    else if (this._call && this._micState === "denied") toast = html`<div class="toast">${t("mic_denied")}</div>`;
    else if (this._call && this._micState === "unavailable") toast = html`<div class="toast">${t("mic_unavailable")}</div>`;
    else if (this._call && this._micState === "error") toast = html`<div class="toast">${t("mic_error")}</div>`;
    else if (this._noFrames && this._hasVideo) toast = html`<div class="toast">${t("no_frames")}</div>`;
    else if (this._call && this._twoWay === false) toast = html`<div class="toast">${t("no_two_way")}</div>`;
    return html`<div class="stage ${s.fit}">
      ${snapshot}
      <video class=${this._hasVideo ? "" : "off"} autoplay playsinline muted></video>
      ${center}${toast}
    </div>`;
  }

  private _renderMic(t: Strings): TemplateResult | typeof nothing {
    if (!this._call) return nothing;
    const off = this._twoWay === false;
    if (this._s.talk_mode === "hold") {
      return html`<button class="pill talk ${this._talking ? "on" : ""}" ?disabled=${off}
        @pointerdown=${this._talkDown} @pointerup=${this._talkUp} @pointercancel=${this._talkUp} @pointerleave=${this._talkUp} @contextmenu=${(e: Event) => e.preventDefault()}>
        <ha-icon icon=${this._talking ? "mdi:microphone" : "mdi:microphone-outline"}></ha-icon>${this._talking ? t("mic_talking") : t("mic_hold")}
      </button>`;
    }
    const starting = this._micState === "starting";
    const label = starting ? t("mic_starting") : this._micOn ? t("mic_on") : t("mic_off");
    return html`<button class="round ${this._micOn ? "on" : ""}" ?disabled=${off || starting} @click=${this._toggleMic} aria-label=${label} title=${label}>
      <ha-icon icon=${this._micOn ? "mdi:microphone" : "mdi:microphone-off"}></ha-icon>
    </button>`;
  }

  private _renderDoor(t: Strings, now: number): TemplateResult | typeof nothing {
    const s = this._s;
    if (!s.door) return nothing;
    const isArmed = armed(this._armUntil, now);
    const label = this._doorMsg === "done" ? t("door_done") : this._doorMsg === "error" ? t("door_error")
      : isArmed ? t("door_confirm") : this._holding ? t("door_hold") : s.door_label || t("door");
    const icon = this._doorMsg === "done" ? "mdi:check" : this._doorMsg === "error" ? "mdi:alert" : isArmed ? "mdi:lock-open-alert" : "mdi:door-open";
    const fill = isArmed ? `width:${(armLeft(this._armUntil, now, s.confirm_seconds) * 100).toFixed(1)}%` : "";
    return html`<button class="pill door ${isArmed ? "armed" : ""} ${this._holding ? "holding" : ""} ${this._doorMsg}"
      @click=${this._doorClick} @pointerdown=${this._doorDown} @pointerup=${this._doorUp} @pointercancel=${this._doorUp} @pointerleave=${this._doorUp}
      @contextmenu=${(e: Event) => e.preventDefault()}>
      <span class="fill" style=${fill}></span><ha-icon icon=${icon}></ha-icon><span class="txt">${label}</span>
    </button>`;
  }

  private _renderChips(): TemplateResult | typeof nothing {
    const ids = [...this._s.info];
    if (this._s.door_sensor && !ids.includes(this._s.door_sensor)) ids.unshift(this._s.door_sensor);
    const chips = ids.map((id) => this.hass?.states[id]).filter((st): st is HassState => !!st);
    if (!chips.length) return nothing;
    return html`<div class="chips">${chips.map((st) => html`<span class="chip">
      <state-badge .hass=${this.hass} .stateObj=${st} .stateColor=${true}></state-badge>
      <span>${this._stateText(st)}</span>
    </span>`)}</div>`;
  }

  protected render(): TemplateResult | typeof nothing {
    if (!this._config) return nothing;
    const s = this._s, t = this._t();
    const now = this._now || Date.now();
    const cam = s.camera ? this.hass?.states[s.camera] : undefined;
    const ringing = !this._call && (isRinging(this.hass?.states[s.ring]) || (this._ringAt > 0 && now - this._ringAt < RING_BANNER_MS));
    const status = this._call
      ? html`<span class="status call">${t("in_call")}${this._callEnds ? ` · ${fmtClock((this._callEnds - now) / 1000)}` : ""}</span>`
      : ringing ? html`<span class="status ring">${t("ringing")}</span>`
      : html`<span class="status">${this._lockText(t)}</span>`;
    return html`<ha-card class=${ringing ? "ringing" : ""}>
      <div class="head">
        <ha-icon icon=${ringing ? "mdi:bell-ring" : "mdi:doorbell-video"}></ha-icon>
        <span class="title">${s.title || t("title")}</span>
        ${status}
        ${this.overlay ? html`<button class="round small" @click=${this._endCall} aria-label=${t("close")}><ha-icon icon="mdi:close"></ha-icon></button>` : nothing}
      </div>
      ${this._renderStage(t, cam)}
      ${this._renderChips()}
      <div class="bar">
        ${this._renderMic(t)}
        ${this._call ? html`<button class="round ${this._speaker && !this._needsGesture ? "" : "muted"}" @click=${this._needsGesture ? this._enableAudio : this._toggleSpeaker}
          aria-label=${this._speaker ? t("speaker_on") : t("speaker_off")} title=${this._speaker ? t("speaker_on") : t("speaker_off")}>
          <ha-icon icon=${this._speaker && !this._needsGesture ? "mdi:volume-high" : "mdi:volume-off"}></ha-icon></button>` : nothing}
        ${this._call
          ? html`<button class="round end" @click=${this._endCall} aria-label=${t("end")} title=${t("end")}><ha-icon icon="mdi:phone-hangup"></ha-icon></button>`
          : s.camera ? html`<button class="pill primary" @click=${this._watch}><ha-icon icon="mdi:video"></ha-icon><span class="txt">${t("start")}</span></button>` : nothing}
        ${this._renderDoor(t, now)}
      </div>
    </ha-card>`;
  }

  static styles = css`
    :host { display: block; }
    :host([overlay]) { height: 100%; }
    ha-card { display: flex; flex-direction: column; overflow: hidden; height: 100%; box-sizing: border-box; }
    ha-card.ringing { box-shadow: 0 0 0 2px var(--warning-color, #ffa600); }
    .head { display: flex; align-items: center; gap: 10px; padding: 12px 16px 10px; min-height: 40px; }
    .title { flex: 1; min-width: 0; font-size: 1.1rem; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .status { font-size: 0.9rem; color: var(--secondary-text-color); white-space: nowrap; }
    .status.call { color: var(--success-color, #43a047); font-weight: 600; font-variant-numeric: tabular-nums; }
    .status.ring { color: var(--warning-color, #ffa600); font-weight: 600; animation: pulse 1s ease-in-out infinite; }
    @keyframes pulse { 50% { opacity: 0.45; } }
    .stage { position: relative; margin: 0 12px; border-radius: 12px; overflow: hidden; background: #000; aspect-ratio: 4 / 3; max-height: 70vh;
      display: flex; align-items: center; justify-content: center; }
    :host([overlay]) .stage { flex: 1; min-height: 0; aspect-ratio: auto; max-height: none; }
    .stage video, .stage img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; }
    .stage.cover video, .stage.cover img { object-fit: cover; }
    .stage video.off { visibility: hidden; }
    .center { position: relative; z-index: 1; display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 12px; color: #fff; text-align: center; text-shadow: 0 1px 3px #000; }
    .center small { opacity: 0.75; max-width: 28em; overflow-wrap: anywhere; }
    .spin { width: 28px; height: 28px; border-radius: 50%; border: 3px solid rgba(255, 255, 255, 0.3); border-top-color: #fff; animation: spin 0.9s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
    button { font: inherit; border: none; cursor: pointer; color: var(--primary-text-color); background: var(--secondary-background-color);
      -webkit-tap-highlight-color: transparent; touch-action: manipulation; user-select: none; -webkit-user-select: none; }
    button:disabled { opacity: 0.4; cursor: default; }
    .play { position: relative; z-index: 1; width: 72px; height: 72px; border-radius: 50%; background: rgba(0, 0, 0, 0.55); color: #fff; --mdc-icon-size: 40px;
      display: inline-flex; align-items: center; justify-content: center; }
    .toast { position: absolute; left: 8px; right: 8px; bottom: 8px; z-index: 2; display: flex; align-items: center; justify-content: center; gap: 8px;
      padding: 8px 12px; border-radius: 10px; background: rgba(0, 0, 0, 0.72); color: #fff; font-size: 0.9rem; text-align: center; }
    .toast.tap { min-height: 44px; background: var(--primary-color); color: var(--text-primary-color, #fff); font-weight: 500; }
    .chips { display: flex; flex-wrap: wrap; justify-content: center; gap: 6px; padding: 10px 12px 0; }
    .chip { display: inline-flex; align-items: center; gap: 2px; min-height: 32px; padding: 0 12px 0 2px; border-radius: 16px; background: var(--secondary-background-color); font-size: 0.85rem; }
    .chip state-badge { width: 32px; height: 32px; --mdc-icon-size: 20px; }
    .bar { display: flex; flex-wrap: wrap; align-items: center; justify-content: center; gap: 12px; padding: 12px; }
    .round { width: 56px; height: 56px; flex: none; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; }
    .round.small { width: 44px; height: 44px; }
    .round.on { background: var(--success-color, #43a047); color: #fff; }
    .round.muted { color: var(--secondary-text-color); }
    .round.end { background: var(--error-color, #db4437); color: #fff; }
    .pill { position: relative; overflow: hidden; height: 56px; min-width: 150px; padding: 0 22px; border-radius: 28px;
      display: inline-flex; align-items: center; justify-content: center; gap: 8px; font-weight: 500; }
    .pill .txt, .pill ha-icon { position: relative; z-index: 1; }
    .pill.primary { background: var(--primary-color); color: var(--text-primary-color, #fff); }
    .pill.talk.on { background: var(--success-color, #43a047); color: #fff; }
    .door { min-width: 190px; flex: 1 1 190px; max-width: 360px; }
    .door.armed { background: var(--error-color, #db4437); color: #fff; }
    .door.done { background: var(--success-color, #43a047); color: #fff; }
    .door.error { background: var(--warning-color, #ffa600); color: #fff; }
    .door .fill { position: absolute; left: 0; top: 0; bottom: 0; width: 0; background: rgba(255, 255, 255, 0.22); pointer-events: none; }
    .door.armed .fill { transition: width 0.25s linear; }
    .door.holding .fill { width: 100%; background: var(--error-color, #db4437); opacity: 0.55; transition: width 1.5s linear; }
  `;
}

customElements.define("videocitofono-card", VideocitofonoCard);

const w = window as unknown as { customCards?: Record<string, unknown>[] };
w.customCards = w.customCards ?? [];
w.customCards.push({
  type: "videocitofono-card",
  name: "Videocitofono",
  description: "Video e audio bidirezionale del videocitofono, apertura automatica alla suonata, apriporta con conferma.",
  preview: false,
  documentationURL: "https://github.com/hubcasale/videocitofono-card",
});
startWatcher();
console.info(`%c VIDEOCITOFONO-CARD %c ${VERSION} `, "color:#fff;background:#3f51b5;font-weight:700", "color:#3f51b5;background:#fff");
