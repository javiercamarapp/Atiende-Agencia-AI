// F4c -- "nada cambia sin configuracion": con tono, mensaje del dueno e idiomas por omision, los prompts de PM (WhatsApp y voz) son BYTE A BYTE los que arman los
// constructores que F4c NO toca (`buildPmSystemPrompt`, `bloqueReglasVozPm`, `comportamientoVozPm`). Se compara contra esos constructores en vivo y no contra una huella
// fija: una huella absoluta se rompe cada vez que otra rama edita el texto del perfil de PM (la CI prueba la mezcla con main), sin que F4c haya cambiado nada.
// Todos los datos son sinteticos; el reloj va fijo.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { InMemoryRestaurantesRepository, armarInstruccionLlamada, bloqueIdiomasVoz, bloquePersonalizacionPrompt, CONFIG_IDIOMAS_VOZ_POR_OMISION } from "../src/index.ts";
import type { VozConfig } from "../src/index.ts";
import { APENDICE_VOZ } from "../src/voz/perfil-voz-pm.ts";
import { NOTA_DE_VOZ_RULES, PM_CONFIG_POR_OMISION, FALLBACK_CONFIG, buildSystemPrompt, saludoSegunHora } from "../src/whatsapp/llm-turn-handler.ts";
import { PM_AGENT_NAME_POR_OMISION, buildPmSystemPrompt } from "../src/whatsapp/perfil-pm.ts";

const ORG = "00000000-0000-4000-8000-000000000001";
const PROP = "00000000-0000-4000-8000-0000000000a1";
const AHORA = new Date("2026-03-10T18:00:00.000Z");
const ZONA = "America/Merida";

beforeAll(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(AHORA);
});
afterAll(() => {
  vi.useRealTimers();
});

function repo() {
  const r = new InMemoryRestaurantesRepository();
  r.seedOrganization({ id: ORG, slug: "taqueria-de-prueba", name: "Taqueria de prueba" });
  r.seedBranch({ propertyId: PROP, organizationId: ORG, name: "Sucursal Uno", slug: "uno", status: "active", phone: null, address: null, lat: null, lng: null });
  return r;
}
const CONFIG_VOZ: VozConfig = { habilitado: true, proveedor: "gemini-3.8-live", voiceId: "Kore", comportamiento: "", mensajeInicial: "", configurada: true };
const fechaHora = new Intl.DateTimeFormat("es-MX", { timeZone: ZONA, dateStyle: "long", timeStyle: "short", hourCycle: "h23" }).format(AHORA);
const dia = new Intl.DateTimeFormat("es-MX", { timeZone: ZONA, weekday: "long" }).format(AHORA);

describe("F4c: sin configuracion el prompt de PM es el de los constructores intactos", () => {
  it("WhatsApp PM = buildPmSystemPrompt + reglas de notas de voz (bloque de personalizacion vacio)", () => {
    expect(bloquePersonalizacionPrompt(null, null)).toBe("");
    expect(bloquePersonalizacionPrompt({ tono: null, mensajeDueno: null }, null)).toBe("");
    const esperado =
      buildPmSystemPrompt({
        businessName: PM_CONFIG_POR_OMISION.businessName,
        agentName: PM_AGENT_NAME_POR_OMISION,
        deliveryTimeText: PM_CONFIG_POR_OMISION.deliveryTimeText,
        saludo: saludoSegunHora(ZONA, AHORA),
        branches: [],
        entryBranch: null,
        customer: { isNew: true },
        fechaHoraLocal: fechaHora,
        diaSemana: dia,
        saludoPersonalizado: null,
        salsasTexto: null,
        promosTexto: null,
        motivosDesactivados: [],
        pedidoGrandeTexto: null,
        urlFacturacion: null,
        conocimientoBloque: "",
      }) +
      "\n\n" +
      NOTA_DE_VOZ_RULES;
    expect(buildSystemPrompt(PM_CONFIG_POR_OMISION, [], { isNew: true }, AHORA, null, "", "", false)).toBe(esperado);
  });

  it("WhatsApp generico: el bloque vacio no cambia nada", () => {
    expect(buildSystemPrompt(FALLBACK_CONFIG, [], { isNew: true }, AHORA, null, "", "", false)).toBe(buildSystemPrompt(FALLBACK_CONFIG, [], { isNew: true }, AHORA));
  });

  it("voz: con espanol por omision la instruccion de la llamada es el perfil de voz + apendice, sin bloque de idiomas", async () => {
    expect(bloqueIdiomasVoz(CONFIG_IDIOMAS_VOZ_POR_OMISION)).toBe("");
    const r = await armarInstruccionLlamada(repo(), { organizationId: ORG, propertyId: PROP, telefono: null, config: CONFIG_VOZ, ahora: AHORA, idiomas: CONFIG_IDIOMAS_VOZ_POR_OMISION });
    const sin = await armarInstruccionLlamada(repo(), { organizationId: ORG, propertyId: PROP, telefono: null, config: CONFIG_VOZ, ahora: AHORA });
    const esperado =
      buildPmSystemPrompt({
        canal: "voz",
        businessName: FALLBACK_CONFIG.businessName,
        agentName: PM_AGENT_NAME_POR_OMISION,
        deliveryTimeText: FALLBACK_CONFIG.deliveryTimeText,
        saludo: saludoSegunHora(ZONA, AHORA),
        branches: await repo().listBranchesForOrganization(ORG),
        entryBranch: { name: "Sucursal Uno", slug: "uno" },
        customer: { isNew: true },
        fechaHoraLocal: fechaHora,
        diaSemana: dia,
        saludoPersonalizado: null,
        salsasTexto: null,
        promosTexto: null,
        motivosDesactivados: [],
        pedidoGrandeTexto: null,
      }) + APENDICE_VOZ;
    expect(sin.instruccion).toBe(r.instruccion);
    expect(r.instruccion).toBe(esperado);
    expect(r.instruccion).not.toContain("# IDIOMAS DE LA LLAMADA");
  });
});
