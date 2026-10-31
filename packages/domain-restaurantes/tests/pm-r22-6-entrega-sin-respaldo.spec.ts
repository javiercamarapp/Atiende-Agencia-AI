// R22 decision 6: tiempo de entrega 40-50 min y con lluvia 1 h a 1 h 20 (web de PM); se quitan del agente las afirmaciones sin respaldo:
// «entre la 1 am y las 12 nadie contesta», «alcohol no se toma para recoger» y «sin minimo para recoger» (lo dice el seed/herramienta).
import { describe, expect, it } from "vitest";
import { PM_CONFIG_POR_OMISION } from "../src/whatsapp/llm-turn-handler.ts";
import { PM_TIEMPO_LLUVIA, buildPmSystemPrompt } from "../src/whatsapp/perfil-pm.ts";
import { comportamientoVozPm } from "../src/voz/perfil-voz-pm.ts";
import { loadSeedInputs } from "../../../scripts/seed-pm-demo/seed-pm-demo.ts";

const branches = [{ propertyId: "p0", slug: "garcia-lavin", name: "García Lavín", address: null }];
const base = { businessName: PM_CONFIG_POR_OMISION.businessName, agentName: "el asistente virtual", deliveryTimeText: PM_CONFIG_POR_OMISION.deliveryTimeText, branches };
const wa = buildPmSystemPrompt({ ...base, saludo: "Buenas tardes", entryBranch: null, customer: { isNew: true }, fechaHoraLocal: "lunes 14:00", diaSemana: "lunes" });
const voz = comportamientoVozPm(base);

describe("R22-6 entrega y afirmaciones sin respaldo", () => {
  it("el tiempo normal es 40 a 50 minutos y con lluvia 1 h a 1 h 20", () => {
    expect(loadSeedInputs().data.agente_whatsapp.tiempo_entrega).toMatch(/de 40 a 50 minutos/);
    expect(PM_TIEMPO_LLUVIA).toBe("de 1 hora a 1 hora 20 minutos a domicilio");
  });
  it.each([["whatsapp", wa], ["voz", voz]])("%s: lluvia = cifra de la web y sin el margen provisional de +20 minutos", (_c, p) => {
    expect(p).toContain(`con lluvia la entrega tarda ${PM_TIEMPO_LLUVIA}`);
    expect(p).not.toMatch(/más unos \d+ minutos/);
    expect(p).not.toMatch(/provisional/i);
  });
  it.each([["whatsapp", wa], ["voz", voz]])("%s: no afirma que el alcohol no se toma para recoger ni que recoger no tiene minimo", (_c, p) => {
    expect(p).not.toMatch(/adquirirlo directamente en la sucursal/);
    expect(p).not.toMatch(/Para recoger,? no (lo )?tome alcohol/);
    expect(p).not.toMatch(/Recoger: sin mínimo|Para recoger no hay mínimo/);
    expect(p).toMatch(/alcohol a domicilio/);
  });
  it("la cifra de lluvia es a domicilio y el prompt de WhatsApp no se la da a quien recoge", () => {
    for (const p of [wa, voz]) expect(p).toMatch(/1 hora 20 minutos a domicilio/);
    expect(wa).toMatch(/a quien va a recoger no le dé esa cifra/);
  });
  it("whatsapp: no afirma un horario de respuesta del equipo (entre la 1 am y las 12 nadie contesta)", () => {
    expect(wa).not.toMatch(/nadie del equipo contesta/);
    expect(wa).not.toMatch(/a partir de las 12 del día/);
    expect(wa).toMatch(/le responden en cuanto puedan/);
  });
});
