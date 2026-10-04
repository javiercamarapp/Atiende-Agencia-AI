// D-26: procesos de vencimientos contra la base SIN migrar y aislamiento por vencimiento. `AbortAwareFakeSession`
// reproduce el estado abortado (25P02) de Postgres: una sesión falsa plana no detectaría un try/catch sin SAVEPOINT.
import { describe, expect, it, vi } from "vitest";
import type { TenantDbSession } from "@atiende/core-tenancy";
import { InMemoryDespachosRepository } from "../src/in-memory-repository.ts";
import { PostgresDespachosRepository } from "../src/postgres-repository.ts";
import { calcularVencimientosDelPeriodo } from "../src/vencimientos/engine.ts";
import { barrerEscalamientosVencimientos, crearVencimientosDelPeriodo } from "../src/vencimientos/procesos.ts";
import type { FiscalDeadlineRecord } from "../src/types.ts";
import { AbortAwareFakeSession } from "./support/aborting-fake-session.ts";

const ORG = "00000000-0000-0000-0000-0000000000o1";
const PROP = "00000000-0000-0000-0000-0000000000p1";

function pgError(code: string, message: string): Error & { code: string } {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
}

function fila(tipo: string, periodo: string, fecha: string) {
  return {
    id: `00000000-0000-0000-0000-0000000000${tipo.length}${periodo.slice(-2)}`,
    organization_id: ORG,
    property_id: PROP,
    tipo,
    periodo,
    fecha_limite: fecha,
    prioridad: "baja",
    estado: "pendiente",
    fecha_presentacion: null,
    comprobante_url: null,
    created_at: "2026-06-01T00:00:00.000Z",
  };
}

const TIPOS_019 = ["Balanza", "Anual"];
const TIPOS_024 = ["Retenciones", "IMSS", "IMSS-bimestral", "ISN", "Informativa"];

/** Sesión que acepta los 4 tipos originales y rechaza con 23514 los que el CHECK de la base aún no admite (por defecto, los de 019 y los de 024). */
function sesionBaseSinMigrar(nuevos: readonly { tipo: string; periodo: string; fechaLimite: string }[], rechazados: readonly string[] = [...TIPOS_019, ...TIPOS_024]) {
  let i = 0;
  return new AbortAwareFakeSession([
    {
      match: /on conflict \(property_id, tipo, periodo\) do nothing/i,
      respond: () => {
        const n = nuevos[i++]!;
        if (rechazados.includes(n.tipo)) return pgError("23514", 'new row for relation "fiscal_deadline" violates check constraint "fiscal_deadline_tipo_check"');
        return [fila(n.tipo, n.periodo, n.fechaLimite)];
      },
    },
    { match: /select 1/, respond: () => [] },
  ]);
}

describe("crearVencimientosDelPeriodo contra la base SIN migrar (23514 en los tipos de las migraciones 019 y 024)", () => {
  it("omite Balanza y los 5 tipos de la 024, conserva ISR/IVA/DIOT/Nómina y deja la sesión utilizable (sin 25P02 ni ROLLBACK silencioso)", async () => {
    const nuevos = calcularVencimientosDelPeriodo(2026, 6, "2026-06-01");
    const session = sesionBaseSinMigrar(nuevos);
    const repo = new PostgresDespachosRepository(session);

    const r = await crearVencimientosDelPeriodo(repo, session, { organizationId: ORG, propertyId: PROP }, nuevos);

    expect(r.creados.map((d) => d.tipo)).toEqual(["ISR", "IVA", "DIOT", "Nómina"]);
    expect(r.omitidos).toEqual(["Retenciones", "IMSS", "IMSS-bimestral", "ISN", "Balanza"]);
    expect(session.calls).toContain("rollback to savepoint sp_calcular_vencimiento_tipo_nuevo");
    // El COMMIT real del request sigue siendo posible: la sesión no quedó abortada.
    await expect(session.query("select 1;")).resolves.toEqual({ rows: [] });
  });

  it("D-P3-33: base con la 019 pero sin la 024: crea Balanza y omite solo los 5 tipos nuevos", async () => {
    const nuevos = calcularVencimientosDelPeriodo(2026, 6, "2026-06-01");
    const session = sesionBaseSinMigrar(nuevos, TIPOS_024);
    const repo = new PostgresDespachosRepository(session);
    const r = await crearVencimientosDelPeriodo(repo, session, { organizationId: ORG, propertyId: PROP }, nuevos);
    expect(r.creados.map((d) => d.tipo)).toEqual(["ISR", "IVA", "DIOT", "Nómina", "Balanza"]);
    expect(r.omitidos).toEqual(["Retenciones", "IMSS", "IMSS-bimestral", "ISN"]);
    await expect(session.query("select 1;")).resolves.toEqual({ rows: [] });
  });

  it("D-P3-33: con ambas migraciones aplicadas se crean los 11 tipos de diciembre sin omitir ninguno", async () => {
    const nuevos = calcularVencimientosDelPeriodo(2026, 12, "2026-12-01");
    const session = sesionBaseSinMigrar(nuevos, []);
    const repo = new PostgresDespachosRepository(session);
    const r = await crearVencimientosDelPeriodo(repo, session, { organizationId: ORG, propertyId: PROP }, nuevos);
    expect(r.omitidos).toEqual([]);
    expect(r.creados.map((d) => d.tipo)).toEqual(["ISR", "IVA", "DIOT", "Nómina", "Retenciones", "IMSS", "IMSS-bimestral", "ISN", "Balanza", "Informativa", "Anual"]);
  });

  it("en diciembre omite Balanza, Anual y los de la 024", async () => {
    const nuevos = calcularVencimientosDelPeriodo(2026, 12, "2026-12-01");
    const session = sesionBaseSinMigrar(nuevos);
    const repo = new PostgresDespachosRepository(session);
    const r = await crearVencimientosDelPeriodo(repo, session, { organizationId: ORG, propertyId: PROP }, nuevos);
    expect(r.omitidos).toEqual(["Retenciones", "IMSS", "IMSS-bimestral", "ISN", "Balanza", "Informativa", "Anual"]);
    expect(r.creados).toHaveLength(4);
  });

  it("un error que NO es 23514 (p. ej. permiso) se repropaga: no se enmascara un fallo real", async () => {
    const nuevos = calcularVencimientosDelPeriodo(2026, 6, "2026-06-01").filter((n) => n.tipo === "Balanza");
    const session = new AbortAwareFakeSession([{ match: /on conflict/i, respond: () => pgError("42501", "permission denied for table fiscal_deadline") }, { match: /select 1/, respond: () => [] }]);
    const repo = new PostgresDespachosRepository(session);
    await expect(crearVencimientosDelPeriodo(repo, session, { organizationId: ORG, propertyId: PROP }, nuevos)).rejects.toMatchObject({ code: "42501" });
    // aun así la sesión quedó recuperada (ROLLBACK TO SAVEPOINT) para el catch exterior
    await expect(session.query("select 1;")).resolves.toEqual({ rows: [] });
  });
});

const SESION_NOOP: TenantDbSession = { query: async () => ({ rows: [] }), exec: async () => undefined } as unknown as TenantDbSession;

describe("crearVencimientosDelPeriodo corrige fechas viejas", () => {
  it("una fila pendiente con el día 17 fijo (domingo) pasa al lunes hábil; la completada no se toca", async () => {
    const repo = new InMemoryDespachosRepository();
    const viejaIsr = await repo.createDeadline({ organizationId: ORG, propertyId: PROP, tipo: "ISR", periodo: "2026-04", fechaLimite: "2026-05-17", prioridad: "baja" });
    const viejaIva = await repo.createDeadline({ organizationId: ORG, propertyId: PROP, tipo: "IVA", periodo: "2026-04", fechaLimite: "2026-05-17", prioridad: "baja" });
    await repo.markDeadlineCompleted(viejaIva.id, null, "2026-05-15");

    const nuevos = calcularVencimientosDelPeriodo(2026, 4, "2026-04-01");
    const r = await crearVencimientosDelPeriodo(repo, SESION_NOOP, { organizationId: ORG, propertyId: PROP }, nuevos);

    const isr = r.creados.find((d) => d.tipo === "ISR")!;
    expect(isr.id).toBe(viejaIsr.id);
    expect(isr.fechaLimite).toBe("2026-05-18");
    const iva = r.creados.find((d) => d.tipo === "IVA")!;
    expect(iva.estado).toBe("completado");
    expect(iva.fechaLimite).toBe("2026-05-17");
    expect(r.creados.find((d) => d.tipo === "DIOT")!.fechaLimite).toBe("2026-06-01");
    expect(r.omitidos).toEqual([]);
  });
});

function deadline(id: string, fecha: string, tipo: FiscalDeadlineRecord["tipo"] = "ISR"): FiscalDeadlineRecord {
  return { id, organizationId: ORG, propertyId: PROP, tipo, periodo: "2026-06", fechaLimite: fecha, prioridad: "critica", estado: "pendiente", fechaPresentacion: null, comprobanteUrl: null, createdAt: "2026-06-01T00:00:00.000Z" };
}

describe("barrerEscalamientosVencimientos", () => {
  it("un vencimiento 'venenoso' (42501 al escalar) no revierte ni bloquea a los demás y la sesión queda utilizable", async () => {
    let inserts = 0;
    const session = new AbortAwareFakeSession([
      {
        match: /insert into despachos\.deadline_escalation/i,
        respond: () => {
          inserts += 1;
          if (inserts === 1) return pgError("42501", "permission denied for table deadline_escalation");
          return [{ id: "00000000-0000-0000-0000-0000000000e1", deadline_id: "x", level: "nivel_4", sent_at: "2026-07-01T00:00:00.000Z", notes: "n" }];
        },
      },
      { match: /update despachos\.fiscal_deadline set estado/i, respond: () => [] },
      { match: /select 1/, respond: () => [] },
    ]);
    const repo = new PostgresDespachosRepository(session);
    vi.spyOn(repo, "listDeadlines").mockResolvedValue([deadline("d1", "2026-06-01"), deadline("d2", "2026-06-02", "IVA"), deadline("d3", "2026-12-01", "DIOT")]);
    vi.spyOn(repo, "listEscalations").mockResolvedValue([]);
    vi.spyOn(repo, "findOrganizationById").mockResolvedValue({ id: ORG, name: "Despacho" } as never);
    vi.spyOn(repo, "listOrganizationNotificationRecipients").mockResolvedValue([]);

    const r = await barrerEscalamientosVencimientos(repo, session, PROP, "2026-06-10");

    expect(r.evaluados).toBe(3);
    expect(r.fallidos.map((f) => f.id)).toEqual(["d1"]);
    expect(r.escalados.map((e) => e.id)).toEqual(["d2"]);
    expect(r.aunNoToca).toBe(1);
    await expect(session.query("select 1;")).resolves.toEqual({ rows: [] });
  });

  it("idempotente: si ya hay un escalamiento del mismo nivel o mayor no vuelve a escalar", async () => {
    const repo = new InMemoryDespachosRepository();
    const d = await repo.createDeadline({ organizationId: ORG, propertyId: PROP, tipo: "ISR", periodo: "2026-05", fechaLimite: "2026-06-01", prioridad: "critica" });
    const primera = await barrerEscalamientosVencimientos(repo, SESION_NOOP, PROP, "2026-06-10");
    expect(primera.escalados.map((e) => [e.id, e.nivel])).toEqual([[d.id, "nivel_4"]]);
    const segunda = await barrerEscalamientosVencimientos(repo, SESION_NOOP, PROP, "2026-06-10");
    expect(segunda.escalados).toEqual([]);
    expect(segunda.yaEscalados).toBe(1);
    expect(await repo.listEscalations(d.id)).toHaveLength(1);
  });

  // D-P3-33: el barrido avisa por DIAS HABILES. 2026-06-10 es miercoles; el vencimiento vence el viernes 2026-06-19.
  it("avisa a 7, 3 y 1 dia(s) habil(es): nivel_1 -> nivel_2 -> nivel_3; el dia del vencimiento no repite; ya vencido sube a nivel_4; completados se ignoran", async () => {
    const repo = new InMemoryDespachosRepository();
    const d = await repo.createDeadline({ organizationId: ORG, propertyId: PROP, tipo: "IVA", periodo: "2026-05", fechaLimite: "2026-06-19", prioridad: "baja" });
    const hecho = await repo.createDeadline({ organizationId: ORG, propertyId: PROP, tipo: "DIOT", periodo: "2026-05", fechaLimite: "2026-06-01", prioridad: "alta" });
    await repo.markDeadlineCompleted(hecho.id, null, "2026-05-30");
    const dia = async (hoy: string) => (await barrerEscalamientosVencimientos(repo, SESION_NOOP, PROP, hoy)).escalados.map((e) => [e.id, e.nivel]);
    expect(await dia("2026-06-09")).toEqual([]); // martes: 8 dias habiles, aun no toca
    expect(await dia("2026-06-10")).toEqual([[d.id, "nivel_1"]]); // 7 dias habiles (jue 11, vie 12, lun 15 ... vie 19)
    expect(await dia("2026-06-10")).toEqual([]); // idempotente el mismo dia
    expect(await dia("2026-06-15")).toEqual([]); // 4 habiles: sigue en nivel_1, nada nuevo
    expect(await dia("2026-06-16")).toEqual([[d.id, "nivel_2"]]); // 3 habiles
    expect(await dia("2026-06-18")).toEqual([[d.id, "nivel_3"]]); // 1 habil
    expect(await dia("2026-06-19")).toEqual([]); // vence hoy: ya tiene nivel_3
    expect(await dia("2026-06-22")).toEqual([[d.id, "nivel_4"]]); // ya vencio
  });

  it("un cron que se salto dias no pierde el aviso: a 2 dias habiles escala directo a nivel_2", async () => {
    const repo = new InMemoryDespachosRepository();
    const d = await repo.createDeadline({ organizationId: ORG, propertyId: PROP, tipo: "ISR", periodo: "2026-05", fechaLimite: "2026-06-19", prioridad: "baja" });
    const r = await barrerEscalamientosVencimientos(repo, SESION_NOOP, PROP, "2026-06-17"); // 2 habiles
    expect(r.escalados.map((e) => [e.id, e.nivel])).toEqual([[d.id, "nivel_2"]]);
  });

  it("los dias inhabiles no cuentan: con el 17 en lunes el viernes anterior ya es 1 dia habil y el fin de semana no suma", async () => {
    const repo = new InMemoryDespachosRepository();
    const d = await repo.createDeadline({ organizationId: ORG, propertyId: PROP, tipo: "IVA", periodo: "2026-08", fechaLimite: "2026-09-17", prioridad: "baja" });
    // 2026-09-17 es jueves; el 16 de septiembre (miercoles) es festivo: desde el martes 15 falta 1 habil (jueves 17).
    const r = await barrerEscalamientosVencimientos(repo, SESION_NOOP, PROP, "2026-09-15");
    expect(r.escalados.map((e) => [e.id, e.nivel])).toEqual([[d.id, "nivel_3"]]);
  });
});

/** Sesión que registra cada `core.emit_notification` (parametros posicionales) y responde 1 destinatario. */
function sesionQueRegistraEmisiones() {
  const emisiones: Array<{ organizationId: unknown; propertyId: unknown; evento: unknown; severidad: unknown; cuerpo: unknown; enlace: unknown; dedupeKey: unknown; roles: unknown }> = [];
  const session = {
    exec: async () => undefined,
    query: async (sql: string, params: unknown[] = []) => {
      if (/core\.emit_notification/.test(sql)) {
        emisiones.push({ organizationId: params[0], propertyId: params[1], evento: params[2], severidad: params[4], cuerpo: params[6], enlace: params[7], dedupeKey: params[10], roles: params[11] });
        return { rows: [{ emit_notification: 1 }] };
      }
      return { rows: [] };
    },
  } as unknown as TenantDbSession;
  return { session, emisiones };
}

describe("barrerEscalamientosVencimientos emite avisos in-app (campana)", () => {
  it("vence manana/hoy -> vencimiento_proximo; ya vencido -> vencimiento_vencido; una por property por dia, a contadores, sin PII", async () => {
    const repo = new InMemoryDespachosRepository();
    await repo.createDeadline({ organizationId: ORG, propertyId: PROP, tipo: "IVA", periodo: "2026-05", fechaLimite: "2026-06-11", prioridad: "alta" });
    await repo.createDeadline({ organizationId: ORG, propertyId: PROP, tipo: "DIOT", periodo: "2026-05", fechaLimite: "2026-06-10", prioridad: "alta" });
    await repo.createDeadline({ organizationId: ORG, propertyId: PROP, tipo: "ISR", periodo: "2026-05", fechaLimite: "2026-06-01", prioridad: "critica" });
    const { session, emisiones } = sesionQueRegistraEmisiones();

    await barrerEscalamientosVencimientos(repo, session, PROP, "2026-06-10");

    expect(emisiones).toHaveLength(2);
    expect(emisiones[0]).toMatchObject({
      organizationId: ORG,
      propertyId: PROP,
      evento: "despachos.fiscal.vencimiento_proximo",
      severidad: "atencion",
      cuerpo: "Por vencer en 7 días hábiles o menos: 2.",
      enlace: "/despachos/{orgSlug}/vencimientos",
      dedupeKey: `despachos.fiscal.vencimiento_proximo:${PROP}:2026-06-10`,
      roles: ["contador"],
    });
    expect(emisiones[1]).toMatchObject({ evento: "despachos.fiscal.vencimiento_vencido", severidad: "critica", cuerpo: "Vencidas sin presentar: 1.", dedupeKey: `despachos.fiscal.vencimiento_vencido:${PROP}:2026-06-10` });
  });

  it("sin escalamientos nuevos (idempotente) no emite nada", async () => {
    const repo = new InMemoryDespachosRepository();
    await repo.createDeadline({ organizationId: ORG, propertyId: PROP, tipo: "ISR", periodo: "2026-05", fechaLimite: "2026-06-01", prioridad: "critica" });
    await barrerEscalamientosVencimientos(repo, sesionQueRegistraEmisiones().session, PROP, "2026-06-10");
    const { session, emisiones } = sesionQueRegistraEmisiones();
    await barrerEscalamientosVencimientos(repo, session, PROP, "2026-06-10");
    expect(emisiones).toHaveLength(0);
  });

  it("base sin migrar (42883 en core.emit_notification): el barrido NO falla y la sesion queda utilizable (SAVEPOINT, sin 25P02)", async () => {
    const repo = new InMemoryDespachosRepository();
    await repo.createDeadline({ organizationId: ORG, propertyId: PROP, tipo: "ISR", periodo: "2026-05", fechaLimite: "2026-06-01", prioridad: "critica" });
    const session = new AbortAwareFakeSession([
      { match: /core\.emit_notification/i, respond: () => pgError("42883", "function core.emit_notification(uuid) does not exist") },
      { match: /select 1/, respond: () => [] },
    ]);
    const r = await barrerEscalamientosVencimientos(repo, session, PROP, "2026-06-10");
    expect(r.escalados).toHaveLength(1);
    expect(session.calls.some((c) => /rollback to savepoint/i.test(c))).toBe(true);
    await expect(session.query("select 1;")).resolves.toEqual({ rows: [] });
  });
});
