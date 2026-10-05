// R-15: validacion pura del perfil del repartidor, regla de la licencia y compatibilidad con la base SIN migrar (SAVEPOINT).
import { describe, expect, it, vi } from "vitest";
import { PostgresRepartidorPerfilRepository, diasParaVencer, estadoLicencia, validarPerfilEntrada } from "../src/repartidor-perfil/index.ts";
import { AbortAwareFakeSession, type FakeSessionHandler } from "./support/aborting-fake-session.ts";

const ORG = "00000000-0000-4000-8000-0000000000d1";
const USER = "00000000-0000-4000-8000-0000000000d2";
const SIGUIENTE: FakeSessionHandler = { match: /select 1 as siguiente_query_del_request/, respond: () => [{ ok: true }] };

function pgError(code: string, message: string): Error & { code: string } {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
}

const COMPLETO = {
  vehiculoTipo: "moto", placas: " ABC-123 ", disponibilidad: "disponible", turno: "L-V 12:00-20:00",
  licenciaNumero: "LIC-1", licenciaVigencia: "2027-01-31", emergenciaNombre: "Maria Perez", emergenciaTelefono: "+52 (55) 1234-5678",
};

describe("validarPerfilEntrada", () => {
  it("normaliza: recorta textos, deja el telefono en 10 digitos y acepta +52", () => {
    const r = validarPerfilEntrada(COMPLETO);
    expect(r).toEqual({ ok: true, valor: { vehiculoTipo: "moto", placas: "ABC-123", disponibilidad: "disponible", turno: "L-V 12:00-20:00", licenciaNumero: "LIC-1", licenciaVigencia: "2027-01-31", emergenciaNombre: "Maria Perez", emergenciaTelefono: "5512345678" } });
  });

  it("un cuerpo vacio es un perfil valido y vacio (reemplazo completo, disponibilidad por defecto)", () => {
    const r = validarPerfilEntrada({});
    expect(r).toEqual({ ok: true, valor: { vehiculoTipo: null, placas: null, disponibilidad: "disponible", turno: null, licenciaNumero: null, licenciaVigencia: null, emergenciaNombre: null, emergenciaTelefono: null } });
  });

  it.each([
    ["no es objeto", "x", /objeto/],
    ["arreglo", [], /objeto/],
    ["vehiculo desconocido", { vehiculoTipo: "cohete" }, /vehiculoTipo/],
    ["disponibilidad desconocida", { disponibilidad: "vacaciones" }, /disponibilidad/],
    ["placas largas", { placas: "X".repeat(16) }, /placas/],
    ["turno con salto de linea", { turno: "a\nb" }, /turno/],
    ["fecha imposible", { licenciaNumero: "L", licenciaVigencia: "2027-02-31" }, /licenciaVigencia/],
    ["fecha fuera de rango", { licenciaNumero: "L", licenciaVigencia: "1999-01-01" }, /fuera de rango/],
    ["licencia sin vigencia", { licenciaNumero: "L" }, /juntos/],
    ["vigencia sin numero", { licenciaVigencia: "2027-01-31" }, /juntos/],
    ["telefono corto", { emergenciaNombre: "A", emergenciaTelefono: "123" }, /10 dígitos/],
    ["telefono no es texto", { emergenciaNombre: "A", emergenciaTelefono: 5512345678 }, /texto/],
    ["emergencia sin telefono", { emergenciaNombre: "A" }, /juntos/],
    ["emergencia sin nombre", { emergenciaTelefono: "5512345678" }, /juntos/],
  ])("rechaza: %s", (_n, entrada, patron) => {
    const r = validarPerfilEntrada(entrada);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(patron);
  });
});

describe("estadoLicencia (alerta visual < 30 dias)", () => {
  it("diasParaVencer cuenta dias de calendario", () => {
    expect(diasParaVencer("2026-10-10", "2026-10-03")).toBe(7);
    expect(diasParaVencer("2026-10-03", "2026-10-03")).toBe(0);
    expect(diasParaVencer("2026-10-01", "2026-10-03")).toBe(-2);
  });
  it.each([
    [null, "sin_licencia"],
    ["2026-12-31", "vigente"],
    ["2026-11-02", "vigente"], // 30 dias: todavia no alerta
    ["2026-11-01", "por_vencer"], // 29 dias
    ["2026-10-03", "por_vencer"], // vence hoy: todavia valida
    ["2026-10-02", "vencida"],
  ])("vigencia %s => %s", (vigencia, esperado) => {
    expect(estadoLicencia(vigencia, "2026-10-03").estado).toBe(esperado);
  });
});

describe("PostgresRepartidorPerfilRepository (base SIN migrar: SAVEPOINT, nunca transaccion abortada)", () => {
  const ENTRADA = (validarPerfilEntrada(COMPLETO) as { ok: true; valor: Parameters<PostgresRepartidorPerfilRepository["guardar"]>[2] }).valor;

  it.each(["42883", "42P01", "42703"])("obtener: %s => disponible=false y la sesion sigue viva", async (code) => {
    const s = new AbortAwareFakeSession([{ match: /from restaurantes\.repartidor_perfil/, respond: () => pgError(code, "does not exist") }, SIGUIENTE]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(await new PostgresRepartidorPerfilRepository(s).obtener(ORG, USER)).toEqual({ disponible: false, perfil: null });
    await expect(s.query("select 1 as siguiente_query_del_request;")).resolves.toEqual({ rows: [{ ok: true }] });
    expect(s.calls.some((c) => c.startsWith("rollback to savepoint"))).toBe(true);
    warn.mockRestore();
  });

  it("obtener: sin fila => perfil null (disponible)", async () => {
    const s = new AbortAwareFakeSession([{ match: /from restaurantes\.repartidor_perfil/, respond: () => [] }]);
    expect(await new PostgresRepartidorPerfilRepository(s).obtener(ORG, USER)).toEqual({ disponible: true, perfil: null });
  });

  it("obtener: mapea ambos bloques y la fecha", async () => {
    const s = new AbortAwareFakeSession([
      { match: /from restaurantes\.repartidor_perfil/, respond: () => [{ user_id: USER, vehiculo_tipo: "moto", placas: "A", disponibilidad: "en_descanso", turno: null, updated_at: new Date("2026-10-03T00:00:00Z"), licencia_numero: "L", licencia_vigencia: "2027-01-31", emergencia_nombre: "M", emergencia_telefono: "5512345678" }] },
    ]);
    const r = await new PostgresRepartidorPerfilRepository(s).obtener(ORG, USER);
    expect(r.perfil).toMatchObject({ userId: USER, vehiculoTipo: "moto", disponibilidad: "en_descanso", licenciaVigencia: "2027-01-31", updatedAt: "2026-10-03T00:00:00.000Z" });
  });

  it("guardar: base migrada => ok; llama a la funcion con los 10 parametros", async () => {
    const s = new AbortAwareFakeSession([{ match: /guardar_perfil_repartidor/, respond: () => [{}] }]);
    expect(await new PostgresRepartidorPerfilRepository(s).guardar(ORG, USER, ENTRADA)).toEqual({ estado: "ok" });
  });

  it.each([
    ["42501", { estado: "prohibido" }],
    ["P0002", { estado: "no_es_repartidor" }],
  ])("guardar: rechazo %s se vuelve resultado explicito y la sesion sigue viva", async (code, esperado) => {
    const s = new AbortAwareFakeSession([{ match: /guardar_perfil_repartidor/, respond: () => pgError(code, "x") }, SIGUIENTE]);
    expect(await new PostgresRepartidorPerfilRepository(s).guardar(ORG, USER, ENTRADA)).toEqual(esperado);
    await expect(s.query("select 1 as siguiente_query_del_request;")).resolves.toEqual({ rows: [{ ok: true }] });
  });

  it("guardar: 22023 => invalido con el detalle sin el prefijo de la funcion", async () => {
    const s = new AbortAwareFakeSession([{ match: /guardar_perfil_repartidor/, respond: () => pgError("22023", "guardar_perfil_repartidor: vigencia fuera de rango") }, SIGUIENTE]);
    expect(await new PostgresRepartidorPerfilRepository(s).guardar(ORG, USER, ENTRADA)).toEqual({ estado: "invalido", detalle: "vigencia fuera de rango" });
  });

  it("guardar: base SIN migrar (42883) => no_disponible y la sesion sigue viva", async () => {
    const s = new AbortAwareFakeSession([{ match: /guardar_perfil_repartidor/, respond: () => pgError("42883", "function does not exist") }, SIGUIENTE]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(await new PostgresRepartidorPerfilRepository(s).guardar(ORG, USER, ENTRADA)).toEqual({ estado: "no_disponible" });
    await expect(s.query("select 1 as siguiente_query_del_request;")).resolves.toEqual({ rows: [{ ok: true }] });
    warn.mockRestore();
  });

  it("guardar: un error que NO es de negocio ni de compatibilidad (57P01) se repropaga", async () => {
    const s = new AbortAwareFakeSession([{ match: /guardar_perfil_repartidor/, respond: () => pgError("57P01", "admin shutdown") }, SIGUIENTE]);
    await expect(new PostgresRepartidorPerfilRepository(s).guardar(ORG, USER, ENTRADA)).rejects.toMatchObject({ code: "57P01" });
  });

  it("suprimir: ok / prohibido (42501) / base sin migrar", async () => {
    const ok = new AbortAwareFakeSession([{ match: /suprimir_perfil_repartidor/, respond: () => [{ suprimido: true }] }]);
    expect(await new PostgresRepartidorPerfilRepository(ok).suprimir(ORG, USER)).toEqual({ disponible: true, borrado: true, prohibido: false });
    const no = new AbortAwareFakeSession([{ match: /suprimir_perfil_repartidor/, respond: () => pgError("42501", "x") }, SIGUIENTE]);
    expect(await new PostgresRepartidorPerfilRepository(no).suprimir(ORG, USER)).toEqual({ disponible: true, borrado: false, prohibido: true });
    const viejo = new AbortAwareFakeSession([{ match: /suprimir_perfil_repartidor/, respond: () => pgError("42883", "x") }, SIGUIENTE]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(await new PostgresRepartidorPerfilRepository(viejo).suprimir(ORG, USER)).toEqual({ disponible: false, borrado: false, prohibido: false });
    warn.mockRestore();
  });

  it("licenciasPorVencer: mapea filas y degrada contra la base sin migrar", async () => {
    const ok = new AbortAwareFakeSession([{ match: /licencias_por_vencer_sistema/, respond: () => [{ organization_id: ORG, user_id: USER, dias_restantes: "-3" }] }]);
    expect(await new PostgresRepartidorPerfilRepository(ok).licenciasPorVencer(30)).toEqual({ disponible: true, valor: [{ organizationId: ORG, userId: USER, diasRestantes: -3 }] });
    const viejo = new AbortAwareFakeSession([{ match: /licencias_por_vencer_sistema/, respond: () => pgError("42883", "x") }, SIGUIENTE]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(await new PostgresRepartidorPerfilRepository(viejo).licenciasPorVencer(30)).toEqual({ disponible: false, valor: [] });
    warn.mockRestore();
  });
});
