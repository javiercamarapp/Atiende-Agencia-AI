// F4c (paridad menor) -- HUELLAS de bytes de los prompts de PM ANTES de agregar tono, mensaje del dueno e idiomas.
// Regla: con los valores por omision (sin tono, sin mensaje, espanol) el prompt de WhatsApp y el de voz quedan BYTE A BYTE iguales.
// Las huellas se calcularon sobre el codigo previo a F4c; si alguien cambia un byte del prompt de PM por omision, este test lo dice.
// Todos los datos son sinteticos.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { InMemoryRestaurantesRepository, armarInstruccionLlamada, bloqueReglasVozPm, comportamientoVozPm } from "../src/index.ts";
import { FALLBACK_CONFIG, PM_CONFIG_POR_OMISION, buildSystemPrompt } from "../src/whatsapp/llm-turn-handler.ts";
import type { VozConfig } from "../src/index.ts";

const sha = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");
const ORG = "00000000-0000-4000-8000-000000000001";
const PROP = "00000000-0000-4000-8000-0000000000a1";
const AHORA = new Date("2026-03-10T18:00:00.000Z");
const RAMA = { propertyId: PROP, organizationId: ORG, name: "Sucursal Uno", slug: "uno", status: "active" as const, phone: null, address: null, lat: null, lng: null };

function repo() {
  const r = new InMemoryRestaurantesRepository();
  r.seedOrganization({ id: ORG, slug: "taqueria-de-prueba", name: "Taqueria de prueba" });
  r.seedBranch(RAMA);
  return r;
}
const CONFIG_VOZ: VozConfig = { habilitado: true, proveedor: "gemini-3.8-live", voiceId: "Kore", comportamiento: "", mensajeInicial: "", configurada: true };

describe("huellas del prompt de PM por omision (F4c: nada cambia sin configuracion)", () => {
  it("WhatsApp PM", () => {
    const p = buildSystemPrompt(PM_CONFIG_POR_OMISION, [], { isNew: true }, AHORA, null, "", "", false);
    expect({ largo: p.length, sha: sha(p) }).toEqual(HUELLAS.waPm);
  });
  it("WhatsApp generico", () => {
    const p = buildSystemPrompt(FALLBACK_CONFIG, [], { isNew: true }, AHORA, null, "", "", false);
    expect({ largo: p.length, sha: sha(p) }).toEqual(HUELLAS.waGenerico);
  });
  it("voz: comportamiento sembrado y bloque de reglas", () => {
    const base = { businessName: "Taqueria de prueba", agentName: "Ana", deliveryTimeText: "30 minutos" };
    const c = comportamientoVozPm({ ...base, branches: [] });
    const b = bloqueReglasVozPm(base);
    expect({ c: sha(c), b: sha(b) }).toEqual(HUELLAS.vozSembrado);
  });
  it("voz: instruccion de una llamada real (sin comportamiento editado)", async () => {
    const r = await armarInstruccionLlamada(repo(), { organizationId: ORG, propertyId: PROP, telefono: null, config: CONFIG_VOZ, ahora: AHORA });
    expect({ largo: r.instruccion.length, sha: sha(r.instruccion) }).toEqual(HUELLAS.vozLlamada);
  });
  it("voz: instruccion con comportamiento editado", async () => {
    const r = await armarInstruccionLlamada(repo(), { organizationId: ORG, propertyId: PROP, telefono: null, config: { ...CONFIG_VOZ, comportamiento: "Sea breve.", mensajeInicial: "Hola." }, ahora: AHORA });
    expect({ largo: r.instruccion.length, sha: sha(r.instruccion) }).toEqual(HUELLAS.vozEditada);
  });
});

const HUELLAS = {
  waPm: { largo: 59683, sha: "bd9f6e68923e99d43f6d521eb699aeb67dfaa0b329c19f1c3250655db6ac0998" },
  waGenerico: { largo: 12814, sha: "778c1480fbfda37106f40bd1f1cee971a238a4b5d46295b814163673a50cc1f3" },
  vozSembrado: { c: "d92951b8898503c6ef6832dc5299a14d29018852d5c1fb946a251e2451d23c60", b: "85308669dcd469e78c14d9ecc32f8bb2a408a2a362dcfe97f78377d4327d4acc" },
  vozLlamada: { largo: 7877, sha: "5d7e239ed04e6f80c130a8c744421c629bf62a2b862077f356f36651b8e7328c" },
  vozEditada: { largo: 17915, sha: "bcc95d27437cde64f95d3d8409dcac5c80d620103e05f30a3ee353e120b3d872" },
};
