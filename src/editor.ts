import { LitElement, html, nothing } from "lit";
import { EDITOR_SCHEMA, fromEditorData, toEditorData } from "./config";
import type { CardConfig } from "./config";
import { strings } from "./i18n";
import type { Hass } from "./types";

type SchemaItem = { name: string; schema?: SchemaItem[]; selector?: { select?: { options: { value: string; label: string }[] } } & Record<string, unknown> } & Record<string, unknown>;

/** Traduce le etichette delle opzioni dei menu ("campo.valore") nella lingua di Home Assistant. */
function localize(schema: SchemaItem[], t: (key: string) => string): SchemaItem[] {
  return schema.map((item) => {
    if (item.schema) return { ...item, schema: localize(item.schema, t) };
    const sel = item.selector?.select;
    if (!sel) return item;
    return { ...item, selector: { ...item.selector, select: { ...sel, options: sel.options.map((o) => ({ value: o.value, label: t(`o_${o.label}`) || o.value })) } } };
  });
}

/** Editor visuale: un modulo ha-form i cui valori diventano la configurazione della scheda. */
export class VideocitofonoCardEditor extends LitElement {
  static properties = { hass: { attribute: false }, _config: { state: true } };
  declare hass: Hass;
  declare _config: CardConfig | null;
  private _schema?: SchemaItem[];
  private _schemaLang = "";

  constructor() { super(); this._config = null; }

  setConfig(config: CardConfig) { this._config = config ?? {}; }

  private _changed = (ev: CustomEvent) => {
    ev.stopPropagation();
    const config = fromEditorData(ev.detail.value as Record<string, unknown>, this._config);
    this._config = config;
    this.dispatchEvent(new CustomEvent("config-changed", { detail: { config }, bubbles: true, composed: true }));
  };

  render() {
    if (!this.hass || !this._config) return nothing;
    const lang = this.hass.locale?.language ?? this.hass.language ?? "it";
    const t = strings(lang);
    if (!this._schema || this._schemaLang !== lang) { this._schema = localize(EDITOR_SCHEMA as SchemaItem[], t); this._schemaLang = lang; }
    return html`<ha-form
      .hass=${this.hass}
      .data=${toEditorData(this._config)}
      .schema=${this._schema}
      .computeLabel=${(s: { name: string }) => t(`ed_${s.name}`) || s.name}
      .computeHelper=${(s: { name: string }) => t(`h_${s.name}`) || undefined}
      @value-changed=${this._changed}
    ></ha-form>`;
  }
}
customElements.define("videocitofono-card-editor", VideocitofonoCardEditor);
