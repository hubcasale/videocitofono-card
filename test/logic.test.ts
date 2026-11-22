import { test } from "node:test";
import assert from "node:assert/strict";
import { armLeft, armed, doorService, fmtClock, isRinging, readEntitiesEvent, recentRing, ringTriggered, userAllowed } from "../src/logic";

test("doorService: serratura con scrocco, automatica -> open", () => {
  assert.deepEqual(doorService("lock.porta", "auto", 1), { domain: "lock", service: "open" });
});
test("doorService: serratura senza scrocco, automatica -> unlock", () => {
  assert.deepEqual(doorService("lock.porta", "auto", 0), { domain: "lock", service: "unlock" });
  assert.deepEqual(doorService("lock.porta", "auto", undefined), { domain: "lock", service: "unlock" });
});
test("doorService: azione scelta a mano", () => {
  assert.deepEqual(doorService("lock.porta", "unlock", 1), { domain: "lock", service: "unlock" });
  assert.deepEqual(doorService("lock.porta", "open", 0), { domain: "lock", service: "open" });
});
test("doorService: altri domini", () => {
  assert.deepEqual(doorService("button.apri", "auto", 0), { domain: "button", service: "press" });
  assert.deepEqual(doorService("script.apri_cancello", "auto", 0), { domain: "script", service: "turn_on" });
  assert.deepEqual(doorService("cover.cancello", "auto", 0), { domain: "cover", service: "open_cover" });
  assert.deepEqual(doorService("switch.rele", "auto", 0), { domain: "switch", service: "turn_on" });
  assert.equal(doorService("sensor.x", "auto", 0), null);
});

test("ringTriggered: sensore binario da off a on", () => {
  assert.equal(ringTriggered("off", "on", "binary_sensor"), true);
  assert.equal(ringTriggered("on", "on", "binary_sensor"), false);
  assert.equal(ringTriggered("on", "off", "binary_sensor"), false);
});
test("ringTriggered: il ritorno da non disponibile non conta", () => {
  assert.equal(ringTriggered("unavailable", "on", "binary_sensor"), false);
  assert.equal(ringTriggered(undefined, "on", "binary_sensor"), false);
  assert.equal(ringTriggered("unknown", "2026-11-22T10:00:00+00:00", "event"), false);
});
test("ringTriggered: entita' evento, lo stato cambia", () => {
  assert.equal(ringTriggered("2026-11-22T10:00:00+00:00", "2026-11-22T10:05:00+00:00", "event"), true);
  assert.equal(ringTriggered("2026-11-22T10:00:00+00:00", "2026-11-22T10:00:00+00:00", "event"), false);
  assert.equal(ringTriggered("2026-11-22T10:00:00+00:00", "unavailable", "event"), false);
});

test("isRinging", () => {
  assert.equal(isRinging({ entity_id: "binary_sensor.c", state: "on", attributes: {} }), true);
  assert.equal(isRinging({ entity_id: "binary_sensor.c", state: "off", attributes: {} }), false);
  assert.equal(isRinging({ entity_id: "event.c", state: "on", attributes: {} }), false);
  assert.equal(isRinging(undefined), false);
});

test("recentRing: sensore binario cambiato da poco, acceso o appena spento", () => {
  const now = 1_000_000;
  assert.equal(recentRing("binary_sensor", "on", now - 5000, now, 45000), true);
  assert.equal(recentRing("binary_sensor", "off", now - 20000, now, 45000), true);
  assert.equal(recentRing("binary_sensor", "off", now - 60000, now, 45000), false);
  assert.equal(recentRing("binary_sensor", "unavailable", now - 1000, now, 45000), false);
  assert.equal(recentRing("binary_sensor", "off", undefined, now, 45000), false);
});
test("recentRing: entita' evento, vale la data nello stato", () => {
  const now = Date.parse("2026-11-22T10:00:30+00:00");
  assert.equal(recentRing("event", "2026-11-22T10:00:00+00:00", undefined, now, 45000), true);
  assert.equal(recentRing("event", "2026-11-22T09:00:00+00:00", now - 1000, now, 45000), false);
  assert.equal(recentRing("event", "unknown", now, now, 45000), false);
});

test("userAllowed", () => {
  const states = {
    "person.tablet": { entity_id: "person.tablet", state: "home", attributes: { user_id: "u1" } },
    "person.corrado": { entity_id: "person.corrado", state: "home", attributes: { user_id: "u2" } },
  };
  assert.equal(userAllowed([], states, "u9"), true);
  assert.equal(userAllowed(["person.tablet"], states, "u1"), true);
  assert.equal(userAllowed(["person.tablet"], states, "u2"), false);
  assert.equal(userAllowed(["person.tablet"], states, undefined), false);
  assert.equal(userAllowed(["person.manca"], states, "u1"), false);
});

test("fmtClock", () => {
  assert.equal(fmtClock(120), "2:00");
  assert.equal(fmtClock(59.2), "1:00");
  assert.equal(fmtClock(5), "0:05");
  assert.equal(fmtClock(-3), "0:00");
});

test("readEntitiesEvent: stato iniziale, cambio, rimozione, altro", () => {
  assert.deepEqual(readEntitiesEvent({ a: { "binary_sensor.c": { s: "off", lc: 100.5 } } }, "binary_sensor.c"), { state: "off", changedMs: 100500, initial: true });
  assert.deepEqual(readEntitiesEvent({ a: { "binary_sensor.c": { s: "off", lu: 7 } } }, "binary_sensor.c"), { state: "off", changedMs: 7000, initial: true });
  assert.deepEqual(readEntitiesEvent({ c: { "binary_sensor.c": { "+": { s: "on", lc: 200 } } } }, "binary_sensor.c"), { state: "on", changedMs: 200000, initial: false });
  assert.equal(readEntitiesEvent({ c: { "binary_sensor.c": { "+": { lu: 5 } } } }, "binary_sensor.c"), null);
  assert.deepEqual(readEntitiesEvent({ r: ["binary_sensor.c"] }, "binary_sensor.c"), { state: undefined, initial: false });
  assert.equal(readEntitiesEvent({ a: { "sensor.x": { s: "1" } } }, "binary_sensor.c"), null);
});

test("armed / armLeft", () => {
  assert.equal(armed(1000, 999), true);
  assert.equal(armed(1000, 1000), false);
  assert.equal(armed(0, 5), false);
  assert.equal(armLeft(6000, 1000, 5), 1);
  assert.equal(armLeft(6000, 3500, 5), 0.5);
  assert.equal(armLeft(6000, 7000, 5), 0);
});
