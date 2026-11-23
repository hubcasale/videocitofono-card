import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULTS, EDITOR_SCHEMA, fromEditorData, normalize, toEditorData } from "../src/config";
import { strings } from "../src/i18n";

test("normalize: configurazione vuota = valori predefiniti", () => {
  assert.deepEqual(normalize(null), DEFAULTS);
  assert.deepEqual(normalize({}), DEFAULTS);
});

test("normalize: i valori predefiniti sono prudenti", () => {
  const s = normalize({});
  assert.equal(s.auto_talk, false);
  assert.equal(s.popup, false);
  assert.equal(s.confirm, "tap");
});

test("normalize: valori non validi tornano ai predefiniti, i numeri restano nei limiti", () => {
  const s = normalize({ confirm: "boh" as never, talk_mode: 3 as never, confirm_seconds: 99, call_seconds: -5, idle: "x" as never, popup: "si" as never });
  assert.equal(s.confirm, "tap");
  assert.equal(s.talk_mode, "open");
  assert.equal(s.confirm_seconds, 30);
  assert.equal(s.call_seconds, 0);
  assert.equal(s.idle, "snapshot");
  assert.equal(s.popup, false);
});

test("normalize: stringhe ripulite, elenchi accettati anche come stringa singola", () => {
  const s = normalize({ camera: " camera.x ", info: "sensor.a" as never, popup_people: ["person.a", "", 3 as never] });
  assert.equal(s.camera, "camera.x");
  assert.deepEqual(s.info, ["sensor.a"]);
  assert.deepEqual(s.popup_people, ["person.a"]);
});

test("fromEditorData: configurazione compatta, senza i valori predefiniti", () => {
  const data = { ...toEditorData({}), camera: "camera.c", ring: "binary_sensor.r", door: "lock.p", auto_talk: true, popup: true, popup_people: ["person.tablet"] };
  assert.deepEqual(fromEditorData(data, { type: "custom:videocitofono-card" }), {
    type: "custom:videocitofono-card", camera: "camera.c", ring: "binary_sensor.r", door: "lock.p", auto_talk: true, popup: true, popup_people: ["person.tablet"],
  });
});

test("fromEditorData: le chiavi che l'editor non gestisce restano", () => {
  const base = { type: "custom:videocitofono-card", camera: "camera.c", grid_options: { columns: 12 }, visibility: [{ condition: "user" }] };
  const out = fromEditorData({ ...toEditorData(base), call_seconds: 60 }, base);
  assert.deepEqual(out.grid_options, { columns: 12 });
  assert.deepEqual(out.visibility, [{ condition: "user" }]);
  assert.equal(out.call_seconds, 60);
  assert.equal(out.camera, "camera.c");
});

test("andata e ritorno: la configurazione non cambia passando dall'editor", () => {
  const cfg = { type: "custom:videocitofono-card", title: "Ingresso", camera: "camera.c", ring: "binary_sensor.r", door: "lock.p", confirm: "hold" as const, talk_mode: "hold" as const, info: ["sensor.b"] };
  assert.deepEqual(fromEditorData(toEditorData(cfg), cfg), cfg);
});

test("editor: ogni campo ha un'etichetta in italiano e in inglese, ogni opzione dei menu e' tradotta", () => {
  type Item = { name: string; schema?: Item[]; selector?: { select?: { options: { label: string }[] } } };
  const flat = (items: Item[]): Item[] => items.flatMap((i) => [i, ...(i.schema ? flat(i.schema) : [])]);
  for (const lang of ["it", "en"]) {
    const t = strings(lang);
    for (const item of flat(EDITOR_SCHEMA as Item[])) {
      assert.ok(t(`ed_${item.name}`), `${lang}: manca ed_${item.name}`);
      for (const o of item.selector?.select?.options ?? []) assert.ok(t(`o_${o.label}`), `${lang}: manca o_${o.label}`);
    }
  }
});

test("editor: tutti i campi della configurazione sono nello schema", () => {
  type Item = { name: string; schema?: Item[] };
  const names = new Set<string>();
  const walk = (items: Item[]) => items.forEach((i) => { if (i.schema) walk(i.schema); else names.add(i.name); });
  walk(EDITOR_SCHEMA as Item[]);
  for (const key of Object.keys(DEFAULTS)) assert.ok(names.has(key), `manca ${key}`);
});

test("normalize: telecamera di riserva", () => {
  assert.equal(normalize({}).camera_fallback, "");
  assert.equal(normalize({ camera_fallback: " camera.leggera " }).camera_fallback, "camera.leggera");
  assert.deepEqual(fromEditorData({ ...toEditorData({}), camera: "camera.c", camera_fallback: "camera.l" }, null), { type: "custom:videocitofono-card", camera: "camera.c", camera_fallback: "camera.l" });
});
