import { normalize } from "./config";
import type { CardConfig } from "./config";
import { domainOf, readEntitiesEvent, recentRing, ringTriggered, userAllowed } from "./logic";
import type { EntitiesEvent } from "./logic";
import type { Hass } from "./types";

/**
 * Finestra a tutto schermo che si apre da sola quando suona il campanello, sopra qualunque pagina di Home Assistant.
 *
 * Una scheda con l'opzione "popup" accesa lascia su questo dispositivo (localStorage) una copia della propria configurazione.
 * Questo modulo, caricato con la risorsa della scheda in ogni pagina delle plance, segue il sensore del campanello
 * con `subscribe_entities` e alla suonata crea una scheda in modalita' "overlay" attaccata a document.body.
 * La copia viene tolta quando la stessa scheda viene mostrata con l'opzione spenta (o per un utente non ammesso).
 */
const STORAGE_KEY = "videocitofono-card.popup";
/** Una suonata di meno di 45 secondi fa conta anche se la pagina si e' aperta dopo. */
export const RECENT_MS = 45_000;

type HaRoot = HTMLElement & { hass?: Hass };
type OverlayCard = HTMLElement & { hass?: Hass; overlay?: boolean; setConfig(config: CardConfig): void; ring(): void };

let stored: CardConfig | null = null;
let unsub: (() => void | Promise<void>) | undefined;
let subscribedTo = "";
let lastState: string | undefined;
let host: HTMLDivElement | undefined;
let card: OverlayCard | undefined;
let hassTimer: number | undefined;
let started = false;

const haRoot = (): HaRoot | null => document.querySelector("home-assistant") as HaRoot | null;

function readStored(): CardConfig | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const cfg = raw ? (JSON.parse(raw) as CardConfig) : null;
    return cfg && typeof cfg === "object" && typeof cfg.camera === "string" && typeof cfg.ring === "string" ? cfg : null;
  } catch { return null; }
}

/** C'e' una finestra automatica aperta? Le schede nella pagina, intanto, non avviano una seconda chiamata. */
export const overlayOpen = (): boolean => !!host;

/** Su questo dispositivo la suonata di questa scheda e' gestita dalla finestra automatica? */
export function popupManaged(config: CardConfig | null | undefined, hass: Hass | undefined): boolean {
  const s = normalize(config);
  return s.popup && !!s.camera && !!s.ring && !!hass && userAllowed(s.popup_people, hass.states, hass.user?.id);
}

/** Chiamata dalle schede nella pagina: aggiorna (o toglie) la copia locale usata dalla finestra automatica. */
export function syncPopupConfig(config: CardConfig, hass: Hass): void {
  const s = normalize(config);
  const current = readStored();
  try {
    if (popupManaged(config, hass)) {
      const next = JSON.stringify(config);
      if (JSON.stringify(current) !== next) localStorage.setItem(STORAGE_KEY, next);
    } else if (current && current.ring === s.ring && current.camera === s.camera) {
      localStorage.removeItem(STORAGE_KEY);
    }
  } catch { /* localStorage non disponibile: la finestra automatica resta spenta */ }
  refresh();
}

function closeOverlay(): void {
  if (hassTimer !== undefined) { clearInterval(hassTimer); hassTimer = undefined; }
  host?.remove();
  host = undefined;
  card = undefined;
}

function openOverlay(config: CardConfig): void {
  const hass = haRoot()?.hass;
  if (!hass) return;
  if (card) { card.ring(); return; }
  host = document.createElement("div");
  host.className = "videocitofono-overlay";
  host.style.cssText = "position:fixed;inset:0;z-index:2147483000;background:rgba(0,0,0,.88);display:flex;align-items:stretch;justify-content:center;padding:max(8px,env(safe-area-inset-top)) max(8px,env(safe-area-inset-right)) max(8px,env(safe-area-inset-bottom)) max(8px,env(safe-area-inset-left));box-sizing:border-box;";
  card = document.createElement("videocitofono-card") as OverlayCard;
  card.overlay = true;
  card.style.cssText = "flex:1;max-width:1100px;min-width:0;";
  card.setConfig(config);
  card.hass = hass;
  card.addEventListener("videocitofono-close", closeOverlay);
  host.appendChild(card);
  document.body.appendChild(host);
  // la scheda fuori dalle plance non riceve `hass` da Home Assistant: glielo si passa a mano
  hassTimer = window.setInterval(() => { const h = haRoot()?.hass; if (card && h && card.hass !== h) card.hass = h; }, 500);
  card.ring();
}

function onEvent(ev: EntitiesEvent, config: CardConfig): void {
  const ring = normalize(config).ring;
  const hit = readEntitiesEvent(ev, ring);
  if (!hit) return;
  const domain = domainOf(ring);
  const fire = hit.initial
    ? recentRing(domain, hit.state, hit.changedMs, Date.now(), RECENT_MS)
    : ringTriggered(lastState, hit.state, domain);
  lastState = hit.state;
  if (!fire) return;
  const hass = haRoot()?.hass;
  // il controllo dell'utente si rifa' al momento della suonata: l'elenco delle persone puo' essere cambiato
  if (hass && popupManaged(config, hass)) openOverlay(config);
}

async function subscribe(): Promise<void> {
  const hass = haRoot()?.hass;
  const ring = stored ? normalize(stored).ring : "";
  const key = stored ? JSON.stringify(stored) : "";
  if (key === subscribedTo) return;
  if (unsub) { try { void unsub(); } catch { /* collegamento chiuso */ } unsub = undefined; }
  subscribedTo = key;
  lastState = undefined;
  if (!stored || !ring || !hass) { if (!hass) subscribedTo = "\u0000"; return; }
  const config = stored;
  try {
    unsub = await hass.connection.subscribeMessage<EntitiesEvent>((ev) => onEvent(ev, config), { type: "subscribe_entities", entity_ids: [ring] });
  } catch { subscribedTo = "\u0000"; }
}

function refresh(): void {
  stored = readStored();
  void subscribe();
}

/** Avvia il controllo del campanello (una volta sola per pagina). */
export function startWatcher(): void {
  if (started || typeof window === "undefined" || typeof document === "undefined") return;
  started = true;
  refresh();
  // Home Assistant puo' non essere ancora pronto al caricamento della risorsa: si riprova finche' c'e' il collegamento
  const wait = window.setInterval(() => {
    if (!haRoot()?.hass) return;
    clearInterval(wait);
    subscribedTo = "\u0000";
    refresh();
  }, 1000);
  window.addEventListener("storage", (ev) => { if (ev.key === STORAGE_KEY) refresh(); });
}

/** Solo per le pagine di prova. */
export const _test = { openOverlay, closeOverlay };
