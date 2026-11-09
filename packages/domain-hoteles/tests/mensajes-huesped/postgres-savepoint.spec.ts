// H-P3-03 -- REGLA DURA de compatibilidad con la base sin migrar contra los adaptadores Postgres REALES de mensajes al huesped +
// AbortAwareFakeSession (reproduce el estado ABORTADO de una transaccion de Postgres: tras un error, cualquier consulta posterior lanza
// 25P02 salvo un ROLLBACK TO SAVEPOINT). Una sesion falsa plana NO sirve. Cada test FALLA si se quita el SAVEPOINT.
import { describe, expect, it } from "vitest";
import {
  MensajesHuespedAccessDeniedError,
  MensajesHuespedUnavailableError,
  PostgresMensajesHuespedSistemaRepository,
  PostgresMensajesHuespedStaffRepository,
} from "../../src/index.ts";
import { AbortAwareFakeSession } from "../support/aborting-fake-session.ts";

const P = "00000000-0000-0000-0000-0000000a1a01";
const ORG = "00000000-0000-0000-0000-00000000a001";

function pgError(code: string, message: string): Error & { code: string } {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
}
const tabla = () => pgError("42P01", 'relation "hoteles.mensaje_huesped_config" does not exist');
const funcion = () => pgError("42883", "function hoteles.sistema_slug_aviso(uuid) does not exist");
const siguiente = { match: /select 1 as despues/i, respond: () => [{ ok: 1 }] };

async function sigueUtilizable(session: AbortAwareFakeSession): Promise<void> {
  await expect(session.query("select 1 as despues")).resolves.toEqual({ rows: [{ ok: 1 }] });
  expect(session.calls.some((c) => c.startsWith("rollback to savepoint"))).toBe(true);
}

describe("staff contra la base sin la migracion 046", () => {
  it("listarConfig degrada a disponible:false y la sesion sigue utilizable", async () => {
    const session = new AbortAwareFakeSession([{ match: /from hoteles\.mensaje_huesped_config/i, respond: tabla }, siguiente]);
    await expect(new PostgresMensajesHuespedStaffRepository(session).listarConfig(P)).resolves.toEqual({ disponible: false });
    await sigueUtilizable(session);
  });

  it("historial degrada a disponible:false", async () => {
    const session = new AbortAwareFakeSession([{ match: /historial_mensajes_huesped/i, respond: funcion }, siguiente]);
    await expect(new PostgresMensajesHuespedStaffRepository(session).historial(P, 20)).resolves.toEqual({ disponible: false });
    await sigueUtilizable(session);
  });

  it("guardarConfig lanza MensajesHuespedUnavailableError (503) con la sesion utilizable", async () => {
    const session = new AbortAwareFakeSession([{ match: /insert into hoteles\.mensaje_huesped_config/i, respond: tabla }, siguiente]);
    await expect(new PostgresMensajesHuespedStaffRepository(session).guardarConfig(P, "pre_llegada", { activo: true, horasAntes: 48, resenaUrl: null })).rejects.toBeInstanceOf(MensajesHuespedUnavailableError);
    await sigueUtilizable(session);
  });

  it("guardarConfig sin permiso (42501 de la RLS) lanza MensajesHuespedAccessDeniedError", async () => {
    const session = new AbortAwareFakeSession([{ match: /insert into hoteles\.mensaje_huesped_config/i, respond: () => pgError("42501", "new row violates row-level security policy") }, siguiente]);
    await expect(new PostgresMensajesHuespedStaffRepository(session).guardarConfig(P, "hold.aprobado", { activo: false, horasAntes: null, resenaUrl: null })).rejects.toBeInstanceOf(MensajesHuespedAccessDeniedError);
    await sigueUtilizable(session);
  });

  it("un error que NO es de migracion (40001) se repropaga y deja la sesion utilizable", async () => {
    const session = new AbortAwareFakeSession([{ match: /from hoteles\.mensaje_huesped_config/i, respond: () => pgError("40001", "could not serialize access") }, siguiente]);
    await expect(new PostgresMensajesHuespedStaffRepository(session).listarConfig(P)).rejects.toMatchObject({ code: "40001" });
    await sigueUtilizable(session);
  });

  it("plantillas: lista degrada, guardar/eliminar devuelven 'unavailable' o 'forbidden' sin romper la sesion", async () => {
    const lista = new AbortAwareFakeSession([{ match: /from core\.whatsapp_plantilla/i, respond: () => pgError("42P01", 'relation "core.whatsapp_plantilla" does not exist') }, siguiente]);
    await expect(new PostgresMensajesHuespedStaffRepository(lista).listarPlantillas(ORG)).resolves.toEqual({ disponible: false });
    await sigueUtilizable(lista);

    const guardar = new AbortAwareFakeSession([{ match: /insert into core\.whatsapp_plantilla/i, respond: () => pgError("42501", "rls") }, siguiente]);
    await expect(new PostgresMensajesHuespedStaffRepository(guardar).guardarPlantilla(ORG, "pre_llegada", { nombre: "x", idioma: "es_MX", variables: [], estado: "borrador" })).resolves.toBe("forbidden");
    await sigueUtilizable(guardar);

    const guardarSinTabla = new AbortAwareFakeSession([{ match: /insert into core\.whatsapp_plantilla/i, respond: () => pgError("42P01", "no existe") }, siguiente]);
    await expect(new PostgresMensajesHuespedStaffRepository(guardarSinTabla).guardarPlantilla(ORG, "pre_llegada", { nombre: "x", idioma: "es_MX", variables: [], estado: "borrador" })).resolves.toBe("unavailable");

    const eliminar = new AbortAwareFakeSession([{ match: /delete from core\.whatsapp_plantilla/i, respond: () => pgError("42P01", "no existe") }, siguiente]);
    await expect(new PostgresMensajesHuespedStaffRepository(eliminar).eliminarPlantilla(ORG, "pre_llegada")).resolves.toBe("unavailable");
    await sigueUtilizable(eliminar);
  });

  it("listarConfig devuelve los 8 eventos con los valores por omision donde no hay fila", async () => {
    const session = new AbortAwareFakeSession([
      { match: /from hoteles\.mensaje_huesped_config/i, respond: () => [{ evento: "pre_llegada", activo: true, horas_antes: 72, resena_url: null, actualizado_en: new Date("2031-07-01T10:00:00Z") }] },
    ]);
    const r = await new PostgresMensajesHuespedStaffRepository(session).listarConfig(P);
    expect(r.disponible).toBe(true);
    if (!r.disponible) return;
    expect(r.valor).toHaveLength(8);
    expect(r.valor.find((c) => c.evento === "pre_llegada")).toMatchObject({ activo: true, horasAntes: 72, configurada: true });
    expect(r.valor.find((c) => c.evento === "hold.aprobado")).toMatchObject({ activo: true, configurada: false });
    expect(r.valor.find((c) => c.evento === "post_estancia")).toMatchObject({ activo: false, configurada: false });
  });
});

describe("sistema contra la base sin la migracion 046 / 0050", () => {
  it("resolverPlantilla sin el catalogo (42883) devuelve undefined ('no se puede saber') y la sesion sigue utilizable", async () => {
    const session = new AbortAwareFakeSession([{ match: /whatsapp_plantilla_resolver/i, respond: () => pgError("42883", "function core.whatsapp_plantilla_resolver(uuid, unknown) does not exist") }, siguiente]);
    await expect(new PostgresMensajesHuespedSistemaRepository(session).resolverPlantilla(ORG, "hold.aprobado")).resolves.toBeUndefined();
    await sigueUtilizable(session);
  });

  it("resolverPlantilla consulta el catalogo con la clave 'hoteles.<evento>' y devuelve nombre, idioma y variables", async () => {
    let params: unknown[] | undefined;
    const session = new AbortAwareFakeSession([{ match: /whatsapp_plantilla_resolver/i, respond: () => [{ nombre: "hotel_hold_aprobado", idioma: "es_MX", variables: ["nombre", "hotel"] }] }]);
    const original = session.query.bind(session);
    session.query = (async (sql: string, p?: unknown[]) => {
      params = p;
      return original(sql, p);
    }) as typeof session.query;
    await expect(new PostgresMensajesHuespedSistemaRepository(session).resolverPlantilla(ORG, "hold.aprobado")).resolves.toEqual({ name: "hotel_hold_aprobado", language: "es_MX", variables: ["nombre", "hotel"] });
    expect(params).toEqual([ORG, "hoteles.hold.aprobado"]);
  });

  it("slugAviso sin la migracion devuelve null y la sesion sigue utilizable", async () => {
    const session = new AbortAwareFakeSession([{ match: /sistema_slug_aviso/i, respond: funcion }, siguiente]);
    await expect(new PostgresMensajesHuespedSistemaRepository(session).slugAviso(P)).resolves.toBeNull();
    await sigueUtilizable(session);
  });

  it("listarCandidatos NO traga el error: el ejecutor lo trata como 'no disponible aun' (una transaccion por unidad)", async () => {
    const session = new AbortAwareFakeSession([{ match: /sistema_candidatos_mensajes_huesped/i, respond: () => pgError("42883", "function hoteles.sistema_candidatos_mensajes_huesped(timestamp with time zone, integer, uuid, uuid) does not exist") }]);
    await expect(new PostgresMensajesHuespedSistemaRepository(session).listarCandidatos(new Date("2031-07-02T20:00:00Z"), 10)).rejects.toMatchObject({ code: "42883" });
  });

  it("listarCandidatos mapea las filas (bigint como texto, fechas ISO)", async () => {
    const session = new AbortAwareFakeSession([
      {
        match: /sistema_candidatos_mensajes_huesped/i,
        respond: () => [
          {
            evento: "hold.aprobado", ref_tipo: "hold", ref_id: "r1", organization_id: ORG, property_id: P, propiedad_nombre: "Hotel", org_slug: "hotel", zona_horaria: "America/Mexico_City",
            huesped_nombre: "Ana", telefono: "5511112222", correo: null, llegada: "2031-09-10", salida: "2031-09-12", total_centavos: "119000", vence_en: new Date("2031-07-03T19:00:00Z"),
            disparo_en: new Date("2031-07-02T19:00:00Z"), phone_number_id: "1000", whatsapp_habilitado: true, ultima_entrada_en: null, ventana_inicio: "08:00:00", ventana_fin: "21:00:00", resena_url: null, horas_antes: null,
          },
        ],
      },
    ]);
    const [c] = await new PostgresMensajesHuespedSistemaRepository(session).listarCandidatos(new Date("2031-07-02T20:00:00Z"), 10);
    expect(c).toMatchObject({ totalCentavos: 119000, venceEn: "2031-07-03T19:00:00.000Z", disparoEn: "2031-07-02T19:00:00.000Z", whatsappHabilitado: true });
  });
});
