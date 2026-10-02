// Rn-25 -- las operaciones de STAFF de la programacion contra una base SIN migrar: corren bajo SAVEPOINT.
// Con AbortAwareFakeSession (reproduce el estado abortado 25P02 de una transaccion real) un 42P01 no debe
// dejar la sesion inutilizable; las de SISTEMA dejan subir el error (el cron decide).
import { describe, expect, it } from "vitest";
import { PostgresRentasMensajesAutomaticosRepository } from "../src/index.ts";
import { AbortAwareFakeSession } from "./support/aborting-fake-session.ts";

const PROP = "11111111-1111-4111-8111-111111111111";
const falta = (code: string) => Object.assign(new Error(`relation does not exist (${code})`), { code });

describe("PostgresRentasMensajesAutomaticosRepository", () => {
  it("listar contra una base sin migrar (42P01) responde disponible:false y la sesion sigue utilizable (SAVEPOINT)", async () => {
    const sesion = new AbortAwareFakeSession([
      { match: /from rentas\.mensaje_automatico_config/, respond: () => falta("42P01") },
      { match: /select 1 as vivo/, respond: () => [{ vivo: 1 }] },
    ]);
    const repo = new PostgresRentasMensajesAutomaticosRepository(sesion);
    expect(await repo.listarProgramaciones(PROP)).toEqual({ disponible: false });
    // Sin SAVEPOINT esta consulta fallaria con 25P02.
    expect((await sesion.query<{ vivo: number }>("select 1 as vivo")).rows[0]?.vivo).toBe(1);
    expect(sesion.calls.some((c) => c.startsWith("rollback to savepoint"))).toBe(true);
  });

  it("guardar contra una base sin migrar tambien degrada; un error que no es de migracion pendiente se propaga", async () => {
    const sinMigrar = new PostgresRentasMensajesAutomaticosRepository(new AbortAwareFakeSession([{ match: /insert into rentas\.mensaje_automatico_config/, respond: () => falta("42703") }]));
    expect(await sinMigrar.guardarProgramacion({ organizationId: "o", propertyId: PROP, evento: "check_in", plantillaId: "p", offsetHoras: 10, activo: true, actorId: "u" })).toEqual({ disponible: false });
    const otro = new PostgresRentasMensajesAutomaticosRepository(new AbortAwareFakeSession([{ match: /insert into rentas\.mensaje_automatico_config/, respond: () => falta("23503") }]));
    await expect(otro.guardarProgramacion({ organizationId: "o", propertyId: PROP, evento: "check_in", plantillaId: "p", offsetHoras: 10, activo: true, actorId: "u" })).rejects.toMatchObject({ code: "23503" });
  });

  it("mapea la programacion guardada y las candidatas del cron", async () => {
    const repo = new PostgresRentasMensajesAutomaticosRepository(
      new AbortAwareFakeSession([
        { match: /from rentas\.mensaje_automatico_config/, respond: () => [{ property_id: PROP, evento: "check_out", plantilla_id: "pl", offset_horas: 8, activo: true, actualizado_en: new Date("2030-01-01T00:00:00Z") }] },
        {
          match: /sistema_listar_mensajes_automaticos/,
          respond: () => [{ ocupacion_id: "o1", organization_id: "org", property_id: PROP, unidad_id: "u1", evento: "pre_llegada", offset_horas: -48, plantilla_id: "pl", plantilla_cuerpo: "Hola", plantilla_aprobada: true, plantilla_activa: true, canal_codigo: "airbnb", check_in: "2030-06-10", check_out: "2030-06-12", huesped_nombre: null, propiedad_nombre: "Casa", unidad_nombre: "U1", zona_horaria: "America/Mexico_City" }],
        },
      ]),
    );
    expect(await repo.listarProgramaciones(PROP)).toEqual({ disponible: true, valor: [{ propertyId: PROP, evento: "check_out", plantillaId: "pl", offsetHoras: 8, activo: true, actualizadoEn: "2030-01-01T00:00:00.000Z" }] });
    const [c] = await repo.listarCandidatos(new Date("2030-06-08T06:30:00Z"), 10);
    expect(c).toMatchObject({ ocupacionId: "o1", checkIn: "2030-06-10", canal: "airbnb", plantillaAprobada: true, huespedNombre: null });
  });

  it("las operaciones de sistema NO degradan: el error de migracion pendiente sube al cron", async () => {
    const repo = new PostgresRentasMensajesAutomaticosRepository(new AbortAwareFakeSession([{ match: /sistema_listar_mensajes_automaticos/, respond: () => falta("42883") }]));
    await expect(repo.listarCandidatos(new Date(), 10)).rejects.toMatchObject({ code: "42883" });
  });
});
