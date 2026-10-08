// QA-PM-R5-voz-17 (VZ17): a las 8:00 el agente de voz saludaba «Buenas tardes» y pedia el nombre ANTES de saber si la sucursal estaba abierta. El saludo y el estado
// abierta/cerrada (con el horario real de branch_policy) los decide el SERVIDOR con la hora de America/Merida y viajan en la instruccion de la llamada:
// buenos dias hasta las 11:59, buenas tardes de 12:00 a 19:59, buenas noches desde las 20:00. Sin reloj de proceso: la hora es un dato (`ahora`) y la zona viene de la sucursal,
// asi que la prueba es la misma en TZ UTC, Pacific/Kiritimati, America/Merida y Pacific/Pago_Pago.
// T7-013: el horario de OTRA sucursal que pregunta el cliente sale de branch_policy (consultar_sucursal), nunca del modelo.
import { describe, expect, it } from "vitest";
import { saludoPorHora } from "@atiende/voice-core";
import { InMemoryRestaurantesRepository, armarInstruccionLlamada, resolverMarcadorSaludo } from "../src/index.ts";
import type { VozConfig } from "../src/index.ts";
import { invokeAgentTool } from "../src/agent-tools/registry.ts";
import { buildRestaurantFixture } from "./fixtures.ts";

const ORG = "00000000-0000-4000-8000-000000000001";
const PROP = "00000000-0000-4000-8000-0000000000a1";
const HORARIO = [{ dias: [0, 1, 2, 3, 4, 5, 6], abre: "12:00", cierra: "01:00" }];
const CONFIG: VozConfig = { habilitado: true, proveedor: "gemini-3.8-live", voiceId: "Kore", comportamiento: "", mensajeInicial: "", configurada: true };

// Martes 2026-10-06; Merida = UTC-6 todo el ano.
const merida = (hhmm: string) => new Date(`2026-10-06T${hhmm}:00-06:00`);

async function repoConHorario() {
  const repo = new InMemoryRestaurantesRepository();
  repo.seedOrganization({ id: ORG, slug: "los-taquitos-de-pm", name: "Los Taquitos de PM" });
  repo.seedBranch({ propertyId: PROP, organizationId: ORG, name: "García Lavín (Victory Platz)", slug: "garcia-lavin", status: "active", phone: null, address: null, lat: null, lng: null });
  repo.seedBranchPolicy(PROP, { horario: HORARIO });
  await repo.upsertBranchZonaHoraria(PROP, "America/Merida");
  return repo;
}
const instruccion = async (hhmm: string, config: VozConfig = CONFIG) => (await armarInstruccionLlamada(await repoConHorario(), { organizationId: ORG, propertyId: PROP, telefono: null, config, ahora: merida(hhmm) })).instruccion;

describe("saludoPorHora: la franja la fija el servidor (VZ17)", () => {
  it.each([
    ["04:59", "buenas noches"],
    ["05:00", "buenos días"],
    ["08:00", "buenos días"],
    ["11:59", "buenos días"],
    ["12:00", "buenas tardes"],
    ["19:00", "buenas tardes"],
    ["19:59", "buenas tardes"],
    ["20:00", "buenas noches"],
    ["23:59", "buenas noches"],
    ["00:30", "buenas noches"],
  ])("%s -> %s", (hora, esperado) => {
    expect(saludoPorHora(hora)).toBe(esperado);
  });

  it("una hora que no es hora lanza (nunca saluda mal en silencio)", () => {
    expect(() => saludoPorHora(24)).toThrow(RangeError);
    expect(() => saludoPorHora("ocho")).toThrow(RangeError);
  });
});

describe("VZ17: la instruccion de la llamada lleva el saludo y el estado de la sucursal de la hora de Merida", () => {
  it("08:00: saludo «buenos días», sucursal CERRADA con su apertura a las 12:00 y nunca «buenas tardes» como saludo", async () => {
    const t = await instruccion("08:00");
    expect(t).toMatch(/Salude solo al inicio \("Buenos días, gracias por llamar a/);
    expect(t).not.toMatch(/Salude solo al inicio \("Buenas tardes/);
    expect(t).toMatch(/CERRADA ahora; abre hoy a las 12:00/);
    expect(t).toMatch(/NO tome el pedido ni acepte una hora/);
  });

  it("13:00: «buenas tardes» y ABIERTA hasta la 01:00 (la sucursal no se declara cerrada de dia)", async () => {
    const t = await instruccion("13:00");
    expect(t).toMatch(/Salude solo al inicio \("Buenas tardes, gracias por llamar a/);
    expect(t).toMatch(/ABIERTA y cierra a las 01:00/);
    expect(t).not.toMatch(/CERRADA ahora/);
  });

  it("19:30 sigue siendo «buenas tardes» y 20:00 ya es «buenas noches»", async () => {
    expect(await instruccion("19:30")).toMatch(/Salude solo al inicio \("Buenas tardes,/);
    expect(await instruccion("20:00")).toMatch(/Salude solo al inicio \("Buenas noches,/);
  });

  it("02:16 (la madrugada de T7-010): «buenas noches» y CERRADA, abre hoy a las 12:00", async () => {
    const t = await instruccion("02:16");
    expect(t).toMatch(/Salude solo al inicio \("Buenas noches,/);
    expect(t).toMatch(/CERRADA ahora; abre hoy a las 12:00/);
  });

  it("con comportamiento editado por el dueno: el contexto trae el saludo exclusivo y el estado ANTES de pedir el nombre", async () => {
    const editada: VozConfig = { ...CONFIG, comportamiento: "Hable de usted.", mensajeInicial: "{saludo}, gracias por llamar a Los Taquitos de PM." };
    const t = await instruccion("08:00", editada);
    expect(t).toContain('Saludo según la hora: "Buenos días". Use SOLO ese saludo');
    expect(t).toMatch(/ESTADO DE LA SUCURSAL AHORA[^\n]*consúltelo ANTES de pedir el nombre[^\n]*CERRADA ahora; abre hoy a las 12:00/);
    // El marcador del mensaje inicial se resuelve en el servidor (antes viajaba literal).
    expect(t).toContain("Saluda al iniciar diciendo: Buenos días, gracias por llamar a Los Taquitos de PM.");
    expect(t).not.toContain("{saludo}");
  });

  it("mensaje inicial con {saludo} en el perfil por omision: se resuelve con la hora local, nunca literal", async () => {
    const t = await instruccion("15:00", { ...CONFIG, mensajeInicial: "{saludo}, gracias por llamar." });
    expect(t).toContain('diga exactamente: "Buenas tardes, gracias por llamar."');
    expect(t).not.toContain("{saludo}");
  });

  it("sin horario cargado no inventa estado: la instruccion queda como antes (sin la linea de estado)", async () => {
    const repo = new InMemoryRestaurantesRepository();
    repo.seedOrganization({ id: ORG, slug: "los-taquitos-de-pm", name: "Los Taquitos de PM" });
    repo.seedBranch({ propertyId: PROP, organizationId: ORG, name: "García Lavín (Victory Platz)", slug: "garcia-lavin", status: "active", phone: null, address: null, lat: null, lng: null });
    const r = await armarInstruccionLlamada(repo, { organizationId: ORG, propertyId: PROP, telefono: null, config: CONFIG, ahora: merida("08:00") });
    expect(r.instruccion).not.toMatch(/CERRADA ahora|ABIERTA y cierra/);
  });

  it("resolverMarcadorSaludo usa la zona de la sucursal: 14:00Z son las 08:00 en Merida (buenos días), no las 14:00", () => {
    expect(resolverMarcadorSaludo("{saludo}, gracias.", "America/Merida", new Date("2026-10-06T14:00:00Z"))).toBe("Buenos días, gracias.");
    expect(resolverMarcadorSaludo("{saludo}, gracias.", "America/Merida", new Date("2026-10-07T02:00:00Z"))).toBe("Buenas noches, gracias.");
  });
});

describe("T7-013: el horario de otra sucursal sale de branch_policy, no del modelo", () => {
  it("consultar_sucursal desde el chat de García Lavín sobre Francisco de Montejo devuelve SU horario 12:00-01:00 y su estado", async () => {
    const f = buildRestaurantFixture();
    f.repo.seedBranchPolicy(f.propertyId, { horario: HORARIO });
    await f.repo.upsertBranchZonaHoraria(f.propertyId, "America/Merida");
    const out = await invokeAgentTool(f.repo, { organizationId: f.organizationId, channel: "whatsapp", phone: "+5219990003333", entryPropertyId: "00000000-0000-4000-8000-0000000000ff" }, "consultar_sucursal", { branch_slug: "fco-montejo" });
    const r = out.result as { horario: unknown; branch_slug: string; abierto_ahora: boolean | null };
    expect(r.branch_slug).toBe("fco-montejo");
    expect(r.horario).toEqual(HORARIO);
    expect(typeof r.abierto_ahora === "boolean").toBe(true);
  });
});
