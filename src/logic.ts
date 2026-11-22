import type { DoorAction } from "./config";
import type { HassState } from "./types";

/** Logica pura (senza DOM), coperta dai test. */

export const domainOf = (entityId: string): string => entityId.split(".", 1)[0] ?? "";

const INVALID = new Set(["unavailable", "unknown", "", "none"]);
const valid = (state: string | undefined): state is string => typeof state === "string" && !INVALID.has(state);

/** Bit LockEntityFeature.OPEN: la serratura sa far scattare lo scrocco. */
export const LOCK_OPEN = 1;

/**
 * Servizio da chiamare per aprire la porta.
 * Serratura: "open" fa scattare lo scrocco, "unlock" toglie solo la mandata; "auto" sceglie "open" quando la serratura lo supporta.
 */
export function doorService(entityId: string, action: DoorAction, supportedFeatures: number | undefined): { domain: string; service: string } | null {
  switch (domainOf(entityId)) {
    case "lock": {
      const canOpen = (Number(supportedFeatures) & LOCK_OPEN) !== 0;
      const open = action === "open" || (action === "auto" && canOpen);
      return { domain: "lock", service: open ? "open" : "unlock" };
    }
    case "button": return { domain: "button", service: "press" };
    case "input_button": return { domain: "input_button", service: "press" };
    case "script": return { domain: "script", service: "turn_on" };
    case "scene": return { domain: "scene", service: "turn_on" };
    case "cover": return { domain: "cover", service: "open_cover" };
    case "switch": return { domain: "switch", service: "turn_on" };
    case "input_boolean": return { domain: "input_boolean", service: "turn_on" };
    default: return null;
  }
}

/**
 * Il campanello ha appena suonato? Confronta lo stato prima e dopo.
 * Sensore binario / interruttore: passaggio a "on". Entita' evento: lo stato (data e ora dell'ultimo evento) cambia.
 * Un passaggio da "non disponibile" non conta: succede al riavvio.
 */
export function ringTriggered(before: string | undefined, after: string | undefined, domain: string): boolean {
  if (!valid(after) || before === undefined) return false;
  if (domain === "event") return valid(before) && before !== after;
  return after === "on" && before === "off";
}

/** Sta suonando adesso (solo per i sensori che restano accesi per qualche secondo). */
export function isRinging(state: HassState | undefined): boolean {
  return !!state && domainOf(state.entity_id) !== "event" && state.state === "on";
}

/**
 * Ha suonato da poco? Serve quando la pagina si apre DOPO la suonata (per esempio un'automazione che porta il tablet sulla vista).
 * `changedMs` e' l'istante dell'ultimo cambio di stato; per un'entita' evento vale la data contenuta nello stato.
 * Sensore binario: conta sia "on" sia "off" (appena tornato a riposo).
 */
export function recentRing(domain: string, state: string | undefined, changedMs: number | undefined, nowMs: number, windowMs: number): boolean {
  if (!valid(state)) return false;
  let at = changedMs;
  if (domain === "event") at = Date.parse(state);
  else if (state !== "on" && state !== "off") return false;
  if (at === undefined || !Number.isFinite(at)) return false;
  const age = nowMs - at;
  return age >= -5000 && age <= windowMs;
}

export const changedMs = (state: HassState | undefined): number | undefined => {
  const t = state?.last_changed ? Date.parse(state.last_changed) : NaN;
  return Number.isFinite(t) ? t : undefined;
};

/** La finestra automatica vale per questo utente? Elenco vuoto = tutti; altrimenti l'utente deve essere collegato a una delle persone scelte. */
export function userAllowed(people: string[], states: Record<string, HassState>, userId: string | undefined): boolean {
  if (!people.length) return true;
  if (!userId) return false;
  return people.some((p) => states[p]?.attributes?.user_id === userId);
}

/** Secondi come m:ss. */
export function fmtClock(totalSeconds: number): string {
  const s = Math.max(0, Math.ceil(totalSeconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export interface EntitiesEvent {
  a?: Record<string, { s?: string; lc?: number; lu?: number }>;
  c?: Record<string, { "+"?: { s?: string; lc?: number; lu?: number } }>;
  r?: string[];
}

/**
 * Legge un messaggio di `subscribe_entities` per una sola entita'.
 * Ritorna il nuovo stato (e l'istante dell'ultimo cambio, in ms) oppure null se il messaggio non la riguarda.
 */
export function readEntitiesEvent(ev: EntitiesEvent, entityId: string): { state: string | undefined; changedMs?: number; initial: boolean } | null {
  const added = ev.a?.[entityId];
  if (added) return { state: added.s, changedMs: added.lc !== undefined ? added.lc * 1000 : added.lu !== undefined ? added.lu * 1000 : undefined, initial: true };
  const diff = ev.c?.[entityId]?.["+"];
  if (diff && diff.s !== undefined) return { state: diff.s, changedMs: diff.lc !== undefined ? diff.lc * 1000 : undefined, initial: false };
  if (ev.r?.includes(entityId)) return { state: undefined, initial: false };
  return null;
}

/** Stato della conferma del pulsante apriporta in modalita' "due tocchi". */
export function armed(armUntil: number, nowMs: number): boolean {
  return armUntil > nowMs;
}

/** Frazione (0..1) del tempo di conferma ancora disponibile. */
export function armLeft(armUntil: number, nowMs: number, confirmSeconds: number): number {
  if (!armed(armUntil, nowMs) || confirmSeconds <= 0) return 0;
  return Math.max(0, Math.min(1, (armUntil - nowMs) / (confirmSeconds * 1000)));
}
