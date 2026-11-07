// F4c (2) -- idiomas del agente de voz por sucursal: validacion, bloque acotado y la instruccion de la llamada (PM intacto con espanol).
import { describe, expect, it } from "vitest";
import {
  CONFIG_IDIOMAS_VOZ_POR_OMISION,
  IDIOMAS_VOZ,
  IdiomasVozInvalidosError,
  InMemoryIdiomasVozRepository,
  InMemoryRestaurantesRepository,
  ParidadNoDisponibleError,
  ParidadRechazadaError,
  armarInstruccionLlamada,
  bloqueIdiomasVoz,
  idiomasDeFila,
  instruccionConIdiomas,
  validarConfigIdiomasVoz,
} from "../src/index.ts";
import type { VozConfig } from "../src/index.ts";

const ORG = "00000000-0000-4000-8000-000000000001";
const OTRA_ORG = "00000000-0000-4000-8000-000000000002";
const PROP = "00000000-0000-4000-8000-0000000000a1";
const AHORA = new Date("2026-03-10T18:00:00.000Z");
const CONFIG: VozConfig = { habilitado: true, proveedor: "gemini-3.8-live", voiceId: "Kore", comportamiento: "", mensajeInicial: "Hola, le atiende el asistente virtual.", configurada: true };

function repo() {
  const r = new InMemoryRestaurantesRepository();
  r.seedOrganization({ id: ORG, slug: "taqueria-de-prueba", name: "Taqueria de prueba" });
  r.seedBranch({ propertyId: PROP, organizationId: ORG, name: "Sucursal Uno", slug: "uno", status: "active", phone: null, address: null, lat: null, lng: null });
  return r;
}

describe("catalogo y validacion", () => {
  it("32 idiomas, sin codigos repetidos", () => {
    expect(IDIOMAS_VOZ).toHaveLength(32);
    expect(new Set(IDIOMAS_VOZ.map((i) => i.codigo)).size).toBe(32);
  });

  it("acepta una config valida y conserva el orden", () => {
    expect(validarConfigIdiomasVoz({ principal: "es-MX", adicionales: ["en-US", "fr-FR"], deteccionAutomatica: true })).toEqual({ principal: "es-MX", adicionales: ["en-US", "fr-FR"], deteccionAutomatica: true });
  });

  it.each([
    [{ principal: "xx-YY", adicionales: [], deteccionAutomatica: false }, /principal/],
    [{ principal: "es-MX", adicionales: "en-US", deteccionAutomatica: false }, /lista/],
    [{ principal: "es-MX", adicionales: ["en-US", "en-US"], deteccionAutomatica: false }, /repetido/],
    [{ principal: "es-MX", adicionales: ["es-MX"], deteccionAutomatica: false }, /principal/],
    [{ principal: "es-MX", adicionales: ["en-US", "fr-FR", "de-DE", "it-IT", "pt-BR"], deteccionAutomatica: false }, /maximo 4/],
    [{ principal: "es-MX", adicionales: ["klingon"], deteccionAutomatica: false }, /lista permitida/],
    [{ principal: "es-MX", adicionales: [], deteccionAutomatica: "si" }, /true o false/],
    [{ principal: "es-MX", adicionales: [], deteccionAutomatica: true }, /al menos un idioma adicional/],
  ])("rechaza %j", (raw, patron) => {
    expect(() => validarConfigIdiomasVoz(raw as never)).toThrow(IdiomasVozInvalidosError);
    expect(() => validarConfigIdiomasVoz(raw as never)).toThrow(patron);
  });

  it("una fila escrita directo en la base con un idioma desconocido cae a la config por omision", () => {
    expect(idiomasDeFila({ idioma_principal: "zz-ZZ", idiomas_adicionales: ["en-US"], deteccion_automatica: true, updated_at: new Date() })).toEqual(CONFIG_IDIOMAS_VOZ_POR_OMISION);
    expect(idiomasDeFila({ idioma_principal: "es-MX", idiomas_adicionales: ["es-MX", "zz-ZZ", "en-US"], deteccion_automatica: true, updated_at: new Date() })).toEqual({ principal: "es-MX", adicionales: ["en-US"], deteccionAutomatica: true });
  });
});

describe("bloque de la instruccion", () => {
  it("por omision (solo es-MX, sin deteccion) es cadena vacia y la instruccion no cambia", () => {
    expect(bloqueIdiomasVoz(CONFIG_IDIOMAS_VOZ_POR_OMISION)).toBe("");
    expect(bloqueIdiomasVoz(null)).toBe("");
    expect(instruccionConIdiomas("base", CONFIG_IDIOMAS_VOZ_POR_OMISION)).toBe("base");
  });

  it("con ingles adicional y deteccion: contesta en el idioma del cliente y declara que no cambia reglas", () => {
    const b = bloqueIdiomasVoz({ principal: "es-MX", adicionales: ["en-US"], deteccionAutomatica: true });
    expect(b).toContain("Idioma principal: Español (México) (es-MX)");
    expect(b).toContain("Inglés (Estados Unidos) (en-US)");
    expect(b).toMatch(/conteste en ese idioma/);
    expect(b).toMatch(/NO cambia ninguna regla/);
  });

  it("sin deteccion: cambia solo si el cliente lo pide; sin adicionales y otro principal: no cambia de idioma", () => {
    expect(bloqueIdiomasVoz({ principal: "es-MX", adicionales: ["en-US"], deteccionAutomatica: false })).toMatch(/solo si el cliente se lo pide/);
    const solo = bloqueIdiomasVoz({ principal: "en-US", adicionales: [], deteccionAutomatica: false });
    expect(solo).toContain("Idioma principal: Inglés (Estados Unidos)");
    expect(solo).toMatch(/No cambie de idioma/);
  });
});

describe("armarInstruccionLlamada con idiomas", () => {
  it("sin idiomas o con espanol por omision: BYTE A BYTE igual a la instruccion de siempre", async () => {
    const sin = await armarInstruccionLlamada(repo(), { organizationId: ORG, propertyId: PROP, telefono: null, config: CONFIG, ahora: AHORA });
    const nulo = await armarInstruccionLlamada(repo(), { organizationId: ORG, propertyId: PROP, telefono: null, config: CONFIG, ahora: AHORA, idiomas: null });
    const omision = await armarInstruccionLlamada(repo(), { organizationId: ORG, propertyId: PROP, telefono: null, config: CONFIG, ahora: AHORA, idiomas: CONFIG_IDIOMAS_VOZ_POR_OMISION });
    expect(nulo.instruccion).toBe(sin.instruccion);
    expect(omision.instruccion).toBe(sin.instruccion);
  });

  it("con ingles adicional: el bloque va al FINAL, despues del primer mensaje, y lo anterior queda intacto", async () => {
    const sin = await armarInstruccionLlamada(repo(), { organizationId: ORG, propertyId: PROP, telefono: null, config: CONFIG, ahora: AHORA });
    const con = await armarInstruccionLlamada(repo(), { organizationId: ORG, propertyId: PROP, telefono: null, config: CONFIG, ahora: AHORA, idiomas: { principal: "es-MX", adicionales: ["en-US"], deteccionAutomatica: true } });
    expect(con.instruccion.startsWith(`${sin.instruccion}\n\n# IDIOMAS DE LA LLAMADA`)).toBe(true);
    expect(con.instruccion.indexOf("# IDIOMAS DE LA LLAMADA")).toBeGreaterThan(con.instruccion.indexOf("# PRIMER MENSAJE"));
  });

  it("tambien con el comportamiento editado por el dueno (las reglas duras quedan antes del bloque)", async () => {
    const editada = { ...CONFIG, comportamiento: "Sea breve." };
    const con = await armarInstruccionLlamada(repo(), { organizationId: ORG, propertyId: PROP, telefono: null, config: editada, ahora: AHORA, idiomas: { principal: "en-US", adicionales: [], deteccionAutomatica: false } });
    expect(con.instruccion.indexOf("# REGLAS VIGENTES DE LA PLATAFORMA")).toBeLessThan(con.instruccion.indexOf("# IDIOMAS DE LA LLAMADA"));
  });
});

describe("repositorio en memoria (contrato del adaptador)", () => {
  it("lee por omision, guarda, y bloquea cross-tenant", async () => {
    const r = new InMemoryIdiomasVozRepository();
    expect(await r.leer(PROP)).toMatchObject({ disponible: true, configurado: false, valor: CONFIG_IDIOMAS_VOZ_POR_OMISION });
    const c = { principal: "es-MX" as const, adicionales: ["en-US" as const], deteccionAutomatica: true };
    expect(await r.guardar(ORG, PROP, "u1", c)).toMatchObject({ configurado: true, valor: c });
    await expect(r.guardar(OTRA_ORG, PROP, "u2", c)).rejects.toBeInstanceOf(ParidadRechazadaError);
    expect(r.escrituras).toHaveLength(1);
  });

  it("base sin migrar: lectura honesta (disponible: false) y escritura 503", async () => {
    const r = new InMemoryIdiomasVozRepository();
    r.migrada = false;
    expect(await r.leer(PROP)).toMatchObject({ disponible: false, valor: CONFIG_IDIOMAS_VOZ_POR_OMISION });
    await expect(r.guardar(ORG, PROP, "u1", CONFIG_IDIOMAS_VOZ_POR_OMISION)).rejects.toBeInstanceOf(ParidadNoDisponibleError);
  });
});
