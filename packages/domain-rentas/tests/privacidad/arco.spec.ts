// Rn-07 -- solicitudes ARCO de rentas: validacion, plazos, doble en memoria y adaptador Postgres sobre una sesion que
// reproduce la transaccion abortada (AbortAwareFakeSession) contra una base sin migrar.
import { describe, expect, it } from "vitest";
import { InMemoryRentasPrivacidadRepository, PostgresRentasPrivacidadRepository, folioArco, plazoArco, validarCambioEstadoArco, validarSolicitudArco } from "../../src/index.ts";
import { AbortAwareFakeSession } from "../support/aborting-fake-session.ts";

const ORG = "00000000-0000-0000-0000-0000000000a1";
const OTRA_ORG = "00000000-0000-0000-0000-0000000000b2";
const ENTRADA = { derecho: "acceso", canal: "correo", solicitanteNombre: "Titular Uno", solicitanteContacto: "t1@example.com", detalle: null, recibidaEn: null } as const;

function pgError(code: string, message = `pg ${code}`): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

describe("validacion", () => {
  const ahora = new Date("2026-10-02T12:00:00Z");
  it("acepta una solicitud valida y normaliza espacios", () => {
    const v = validarSolicitudArco({ derecho: "oposicion", canal: "presencial", solicitanteNombre: "  Ana  ", solicitanteContacto: "55 1234", detalle: "  ", recibidaEn: "2026-10-01T10:00:00Z" }, ahora);
    expect(v).toEqual({ ok: true, valor: { derecho: "oposicion", canal: "presencial", solicitanteNombre: "Ana", solicitanteContacto: "55 1234", detalle: null, recibidaEn: "2026-10-01T10:00:00.000Z" } });
  });
  it.each([
    [{ ...ENTRADA, derecho: "borrado" }, /derecho/],
    [{ ...ENTRADA, canal: "whatsapp" }, /canal/],
    [{ ...ENTRADA, solicitanteNombre: "" }, /solicitanteNombre/],
    [{ ...ENTRADA, solicitanteContacto: "x".repeat(161) }, /solicitanteContacto/],
    [{ ...ENTRADA, detalle: "x".repeat(501) }, /detalle/],
    [{ ...ENTRADA, recibidaEn: "2026-10-05T12:00:00Z" }, /futura/],
    [{ ...ENTRADA, recibidaEn: "2026-07-01T12:00:00Z" }, /anterior/],
    [{ ...ENTRADA, recibidaEn: "no-es-fecha" }, /ISO/],
  ])("rechaza %#", (cuerpo, error) => {
    const v = validarSolicitudArco(cuerpo, ahora);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.error).toMatch(error);
  });
  it("rechazar exige nota; solo estados destino validos", () => {
    expect(validarCambioEstadoArco({ estado: "rechazada" }).ok).toBe(false);
    expect(validarCambioEstadoArco({ estado: "rechazada", nota: "No procede" })).toEqual({ ok: true, valor: { estado: "rechazada", nota: "No procede" } });
    expect(validarCambioEstadoArco({ estado: "recibida" }).ok).toBe(false);
    expect(validarCambioEstadoArco({ estado: "resuelta" })).toEqual({ ok: true, valor: { estado: "resuelta", nota: null } });
  });
});

describe("plazoArco y folio", () => {
  const base = { respuestaVenceEn: "2026-10-20T00:00:00Z", ejecucionVenceEn: "2026-11-04T00:00:00Z" };
  it("usa la fecha de respuesta si esta sin atender y la de ejecucion si esta en proceso", () => {
    expect(plazoArco({ estado: "recibida", ...base }, new Date("2026-10-01T00:00:00Z"))).toBe("en_plazo");
    expect(plazoArco({ estado: "recibida", ...base }, new Date("2026-10-16T00:00:00Z"))).toBe("por_vencer");
    expect(plazoArco({ estado: "recibida", ...base }, new Date("2026-10-21T00:00:00Z"))).toBe("vencida");
    expect(plazoArco({ estado: "en_proceso", ...base }, new Date("2026-10-21T00:00:00Z"))).toBe("en_plazo");
    expect(plazoArco({ estado: "resuelta", ...base }, new Date("2030-01-01T00:00:00Z"))).toBe("cerrada");
  });
  it("el folio no contiene el id completo", () => {
    expect(folioArco("12345678-aaaa-bbbb-cccc-dddddddddddd")).toBe("ARCO-R-12345678");
  });
});

describe("doble en memoria", () => {
  it("registra con plazos 20+15, es idempotente por contacto y derecho y no cruza organizaciones", async () => {
    const repo = new InMemoryRentasPrivacidadRepository({ reloj: () => new Date("2026-10-02T00:00:00Z"), actorId: "u1" });
    const a = await repo.registrar(ORG, ENTRADA);
    expect(a.outcome).toBe("created");
    const b = await repo.registrar(ORG, { ...ENTRADA, solicitanteContacto: " T1@Example.com " });
    expect(b).toEqual({ outcome: "existing", id: (a as { id: string }).id });
    const pagina = await repo.listar(ORG, {}, { limit: 10, offset: 0 });
    expect(pagina.total).toBe(1);
    expect(pagina.items[0]).toMatchObject({ respuestaVenceEn: "2026-10-22T00:00:00.000Z", ejecucionVenceEn: "2026-11-06T00:00:00.000Z" });
    expect((await repo.listar(OTRA_ORG, {}, { limit: 10, offset: 0 })).total).toBe(0);
  });
  it("transiciones: resuelta es terminal, rechazar exige nota y otra organizacion no la encuentra", async () => {
    const repo = new InMemoryRentasPrivacidadRepository();
    const { id } = (await repo.registrar(ORG, ENTRADA)) as { id: string };
    expect(await repo.cambiarEstado(OTRA_ORG, id, "en_proceso", null)).toEqual({ outcome: "not_found" });
    expect(await repo.cambiarEstado(ORG, id, "rechazada", null)).toEqual({ outcome: "invalid_input" });
    expect(await repo.cambiarEstado(ORG, id, "en_proceso", null)).toMatchObject({ outcome: "updated" });
    expect(await repo.cambiarEstado(ORG, id, "resuelta", "Listo")).toMatchObject({ outcome: "updated", estado: "resuelta" });
    expect(await repo.cambiarEstado(ORG, id, "en_proceso", null)).toEqual({ outcome: "invalid_transition" });
    expect((await repo.listarEventos(ORG, id))?.map((e) => e.hacia)).toEqual(["recibida", "en_proceso", "resuelta"]);
    expect(await repo.listarEventos(OTRA_ORG, id)).toEqual([]);
  });
  it("sin permiso y sin migrar", async () => {
    expect(await new InMemoryRentasPrivacidadRepository({ autorizado: false }).registrar(ORG, ENTRADA)).toEqual({ outcome: "forbidden" });
    const sinMigrar = new InMemoryRentasPrivacidadRepository({ disponible: false });
    expect(await sinMigrar.registrar(ORG, ENTRADA)).toEqual({ outcome: "unavailable" });
    expect((await sinMigrar.listar(ORG, {}, { limit: 5, offset: 0 })).disponible).toBe(false);
    expect(await sinMigrar.listarEventos(ORG, "x")).toBeNull();
  });
});

describe("PostgresRentasPrivacidadRepository sobre una transaccion que se aborta", () => {
  for (const code of ["42P01", "42703", "42883"]) {
    it(`base sin migrar (${code}): lecturas vacias honestas, escrituras 'unavailable' y la sesion sigue utilizable`, async () => {
      const mensaje = code === "42883" ? "function rentas.arco_registrar(uuid, text) does not exist" : `pg ${code}`;
      const db = new AbortAwareFakeSession([
        { match: /from rentas\.arco_solicitud/, respond: () => pgError(code, mensaje) },
        { match: /from rentas\.arco_evento/, respond: () => pgError(code, mensaje) },
        { match: /rentas\.arco_registrar/, respond: () => pgError(code, mensaje) },
        { match: /rentas\.arco_cambiar_estado/, respond: () => pgError(code, mensaje) },
        { match: /select 1 as vivo/, respond: () => [{ vivo: 1 }] },
      ]);
      const repo = new PostgresRentasPrivacidadRepository(db);
      expect(await repo.listar(ORG, {}, { limit: 10, offset: 0 })).toEqual({ disponible: false, total: 0, items: [], nextOffset: null });
      expect(await repo.listarEventos(ORG, "s1")).toBeNull();
      expect(await repo.registrar(ORG, ENTRADA)).toEqual({ outcome: "unavailable" });
      expect(await repo.cambiarEstado(ORG, "s1", "en_proceso", null)).toEqual({ outcome: "unavailable" });
      await expect(db.query("select 1 as vivo")).resolves.toEqual({ rows: [{ vivo: 1 }] });
    });
  }

  it("errores de negocio de la funcion SQL se traducen y no dejan la transaccion abortada", async () => {
    const respuestas: Record<string, string> = { "42501": "forbidden", P0002: "not_found", "55000": "invalid_transition", "22023": "invalid_input" };
    for (const [code, outcome] of Object.entries(respuestas)) {
      const db = new AbortAwareFakeSession([{ match: /rentas\.arco_cambiar_estado/, respond: () => pgError(code) }, { match: /select 1 as vivo/, respond: () => [{ vivo: 1 }] }]);
      expect(await new PostgresRentasPrivacidadRepository(db).cambiarEstado(ORG, "s1", "resuelta", null)).toEqual({ outcome });
      await expect(db.query("select 1 as vivo")).resolves.toBeDefined();
    }
    const db = new AbortAwareFakeSession([{ match: /rentas\.arco_registrar/, respond: () => pgError("P0002") }, { match: /select 1 as vivo/, respond: () => [{ vivo: 1 }] }]);
    expect(await new PostgresRentasPrivacidadRepository(db).registrar(ORG, ENTRADA)).toEqual({ outcome: "forbidden" });
    await expect(db.query("select 1 as vivo")).resolves.toBeDefined();
  });

  it("un error ajeno a la migracion (40P01) se propaga y no se enmascara", async () => {
    const db = new AbortAwareFakeSession([{ match: /from rentas\.arco_solicitud/, respond: () => pgError("40P01") }]);
    await expect(new PostgresRentasPrivacidadRepository(db).listar(ORG, {}, { limit: 1, offset: 0 })).rejects.toMatchObject({ code: "40P01" });
  });

  it("camino normal: mapea filas, paginacion y registro", async () => {
    const fila = { id: "s1", derecho: "acceso", canal: "correo", estado: "recibida", solicitante_nombre: "T", solicitante_contacto: "t@x.mx", detalle: null, recibida_en: "2026-10-01 00:00:00+00", respuesta_vence_en: "2026-10-21 00:00:00+00", ejecucion_vence_en: "2026-11-05 00:00:00+00", resuelta_en: null, nota_resolucion: null, atendida_por: null, total: "3" };
    const db = new AbortAwareFakeSession([
      { match: /from rentas\.arco_solicitud/, respond: () => [fila] },
      { match: /rentas\.arco_registrar/, respond: () => [{ out_id: "s9", out_creada: false }] },
    ]);
    const repo = new PostgresRentasPrivacidadRepository(db);
    const pagina = await repo.listar(ORG, { estado: "recibida" }, { limit: 1, offset: 0 });
    expect(pagina).toMatchObject({ disponible: true, total: 3, nextOffset: 1 });
    expect(pagina.items[0]).toMatchObject({ id: "s1", solicitanteNombre: "T", estado: "recibida" });
    expect(await repo.registrar(ORG, ENTRADA)).toEqual({ outcome: "existing", id: "s9" });
  });
});
