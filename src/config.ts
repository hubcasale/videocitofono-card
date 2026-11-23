/**
 * Configurazione della scheda (YAML o editor visuale):
 *   type, title, camera, camera_fallback, ring, door, door_action, door_label, door_sensor, confirm, confirm_seconds,
 *   auto_call, auto_talk, popup, popup_people, call_seconds, end_on_open, talk_mode, idle, fit, info
 * Tutte le preferenze stanno qui: la scheda non salva nulla altrove (a parte, su ogni dispositivo, la copia
 * che serve ad aprire la finestra a tutto schermo quando suona il campanello: vedi overlay.ts).
 */
export type ConfirmMode = "tap" | "hold";
export type TalkMode = "open" | "hold";
export type IdleMode = "snapshot" | "live";
export type DoorAction = "auto" | "open" | "unlock";
export type FitMode = "contain" | "cover";

export interface CardConfig {
  type?: string;
  title?: string;
  camera?: string;
  camera_fallback?: string;
  ring?: string;
  door?: string;
  door_action?: DoorAction;
  door_label?: string;
  door_sensor?: string;
  confirm?: ConfirmMode;
  confirm_seconds?: number;
  auto_call?: boolean;
  auto_talk?: boolean;
  popup?: boolean;
  popup_people?: string[];
  call_seconds?: number;
  end_on_open?: boolean;
  talk_mode?: TalkMode;
  idle?: IdleMode;
  fit?: FitMode;
  info?: string[];
  [extra: string]: unknown;
}

export interface Settings {
  title: string;
  camera: string;
  camera_fallback: string;
  ring: string;
  door: string;
  door_action: DoorAction;
  door_label: string;
  door_sensor: string;
  confirm: ConfirmMode;
  confirm_seconds: number;
  auto_call: boolean;
  auto_talk: boolean;
  popup: boolean;
  popup_people: string[];
  call_seconds: number;
  end_on_open: boolean;
  talk_mode: TalkMode;
  idle: IdleMode;
  fit: FitMode;
  info: string[];
}

export const DEFAULTS: Settings = {
  title: "", camera: "", camera_fallback: "", ring: "", door: "", door_action: "auto", door_label: "", door_sensor: "",
  confirm: "tap", confirm_seconds: 5,
  auto_call: true, auto_talk: false, popup: false, popup_people: [],
  call_seconds: 120, end_on_open: true,
  talk_mode: "open", idle: "snapshot", fit: "contain", info: [],
};

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(str).filter(Boolean) : str(v) ? [str(v)] : []);
const pick = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T => (allowed.includes(v as T) ? (v as T) : fallback);
const num = (v: unknown, min: number, max: number, fallback: number): number => {
  const n = Number(v);
  return v === undefined || v === null || v === "" || !Number.isFinite(n) ? fallback : Math.max(min, Math.min(max, Math.round(n)));
};
const bool = (v: unknown, fallback: boolean): boolean => (typeof v === "boolean" ? v : fallback);

/** Porta qualunque configurazione alla forma completa e valida. */
export function normalize(config: CardConfig | null | undefined): Settings {
  const c: CardConfig = config ?? {};
  return {
    title: str(c.title),
    camera: str(c.camera),
    camera_fallback: str(c.camera_fallback),
    ring: str(c.ring),
    door: str(c.door),
    door_action: pick(c.door_action, ["auto", "open", "unlock"] as const, DEFAULTS.door_action),
    door_label: str(c.door_label),
    door_sensor: str(c.door_sensor),
    confirm: pick(c.confirm, ["tap", "hold"] as const, DEFAULTS.confirm),
    confirm_seconds: num(c.confirm_seconds, 2, 30, DEFAULTS.confirm_seconds),
    auto_call: bool(c.auto_call, DEFAULTS.auto_call),
    auto_talk: bool(c.auto_talk, DEFAULTS.auto_talk),
    popup: bool(c.popup, DEFAULTS.popup),
    popup_people: list(c.popup_people),
    call_seconds: num(c.call_seconds, 0, 3600, DEFAULTS.call_seconds),
    end_on_open: bool(c.end_on_open, DEFAULTS.end_on_open),
    talk_mode: pick(c.talk_mode, ["open", "hold"] as const, DEFAULTS.talk_mode),
    idle: pick(c.idle, ["snapshot", "live"] as const, DEFAULTS.idle),
    fit: pick(c.fit, ["contain", "cover"] as const, DEFAULTS.fit),
    info: list(c.info),
  };
}

const OWNED = Object.keys(DEFAULTS).concat("type");

/** Dati per il modulo dell'editor: le impostazioni complete (ha-form mostra anche i valori predefiniti). */
export function toEditorData(config: CardConfig | null | undefined): Record<string, unknown> {
  return { ...normalize(config) };
}

/** Dal modulo dell'editor alla configurazione: compatta (senza i valori predefiniti); le chiavi che l'editor non gestisce restano. */
export function fromEditorData(data: Record<string, unknown>, base: CardConfig | null | undefined): CardConfig {
  const s = normalize(data as CardConfig);
  const out: CardConfig = { type: base?.type ?? "custom:videocitofono-card" };
  for (const key of Object.keys(DEFAULTS) as (keyof Settings)[]) {
    const value = s[key], def = DEFAULTS[key];
    const same = Array.isArray(value) ? value.length === 0 : value === def;
    if (!same) (out as Record<string, unknown>)[key] = value;
  }
  for (const [k, v] of Object.entries(base ?? {})) if (!OWNED.includes(k)) out[k] = v;
  return out;
}

const entity = (name: string, domain: string[], extra: Record<string, unknown> = {}) => ({ name, required: false, selector: { entity: { domain, ...extra } } });
const group = (name: string, schema: unknown[]) => ({ type: "expandable", name, flatten: true, schema });
const select = (name: string, options: string[]) => ({ name, required: false, selector: { select: { mode: "dropdown", options: options.map((value) => ({ value, label: `${name}.${value}` })) } } });
const seconds = (name: string, min: number, max: number) => ({ name, required: false, selector: { number: { min, max, step: 1, mode: "box", unit_of_measurement: "s" } } });
const toggle = (name: string) => ({ name, required: false, selector: { boolean: {} } });

/** Domini accettati per il comando di apertura. */
export const DOOR_DOMAINS = ["lock", "button", "input_button", "script", "switch", "cover", "scene", "input_boolean"];

/** Schema di ha-form. Le etichette delle opzioni dei menu vengono tradotte dall'editor (label = "campo.valore"). */
export const EDITOR_SCHEMA = [
  { name: "title", required: false, selector: { text: {} } },
  entity("camera", ["camera"]),
  entity("camera_fallback", ["camera"]),
  entity("ring", ["binary_sensor", "event", "input_boolean"]),
  group("g_door", [
    entity("door", DOOR_DOMAINS),
    select("door_action", ["auto", "open", "unlock"]),
    { name: "door_label", required: false, selector: { text: {} } },
    select("confirm", ["tap", "hold"]),
    seconds("confirm_seconds", 2, 30),
    entity("door_sensor", ["binary_sensor"]),
  ]),
  group("g_ring", [
    toggle("auto_call"),
    toggle("auto_talk"),
    toggle("popup"),
    entity("popup_people", ["person"], { multiple: true }),
    seconds("call_seconds", 0, 3600),
    toggle("end_on_open"),
  ]),
  group("g_av", [
    select("talk_mode", ["open", "hold"]),
    select("idle", ["snapshot", "live"]),
    select("fit", ["contain", "cover"]),
  ]),
  { name: "info", required: false, selector: { entity: { multiple: true } } },
];
