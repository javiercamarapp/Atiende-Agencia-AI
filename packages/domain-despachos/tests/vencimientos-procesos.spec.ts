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

/** Sesión que acepta los 4 tipos originales y rechaza Balanza/Anual con 23514 (base sin migrar). */
function sesionBaseSinMigrar(nuevos: readonly { tipo: string; periodo: string; fechaLimite: string }[]) {
  let i = 0;
  return new AbortAwareFakeSession([
    {
      match: /on conflict \(property_id, tipo, periodo\) do nothing/i,
      respond: () => {
        const n = nuevos[i++]!;
        if (n.tipo === "Balanza" || n.tipo === "Anual") return pgError("23514", 'new row for relation "fiscal_deadline" violates check constraint "fiscal_deadline_tipo_check"');
        return [fila(n.tipo, n.periodo, n.fechaLimite)];
      },
    },
    { match: /select 1/, respond: () => [] },
  ]);
}

describe("crearVencimientosDelPeriodo contra la base SIN migrar (23514 en Balanza/Anual)", () => {
  it("omite Balanza, conserva ISR/IVA/DIOT/Nómina y deja la sesión utilizable (sin 25P02 ni ROLLBACK silencioso)", async () => {
    const nuevos = calcularVencimientosDelPeriodo(2026, 6, "2026-06-01");
    const session = sesionBaseSinMigrar(nuevos);
    const repo = new PostgresDespachosRepository(session);

    const r = await crearVencimientosDelPeriodo(repo, session, { organizationId: ORG, propertyId: PROP }, nuevos);

    expect(r.creados.map((d) => d.tipo)).toEqual(["ISR", "IVA", "DIOT", "Nómina"]);
    expect(r.omitidos).toEqual(["Balanza"]);
    expect(session.calls).toContain("rollback to savepoint sp_calcular_vencimiento_tipo_nuevo");
    // El COMMIT real del request sigue siendo posible: la sesión no quedó abortada.
    await expect(session.query("select 1;")).resolves.toEqual({ rows: [] });
  });

  it("en diciembre omite Balanza Y Anual", async () => {
    const nuevos = calcularVencimientosDelPeriodo(2026, 12, "2026-12-01");
    const session = sesionBaseSinMigrar(nuevos);
    const repo = new PostgresDespachosRepository(session);
    const r = await crearVencimientosDelPeriodo(repo, session, { organizationId: ORG, propertyId: PROP }, nuevos);
    expect(r.omitidos).toEqual(["Balanza", "Anual"]);
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

  it("vence mañana -> nivel_2; ya fue escalado a nivel_2 y llega el día -> nivel_3 (sube); completados se ignoran", async () => {
    const repo = new InMemoryDespachosRepository();
    const d = await repo.createDeadline({ organizationId: ORG, propertyId: PROP, tipo: "IVA", periodo: "2026-05", fechaLimite: "2026-06-11", prioridad: "alta" });
    const hecho = await repo.createDeadline({ organizationId: ORG, propertyId: PROP, tipo: "DIOT", periodo: "2026-05", fechaLimite: "2026-06-01", prioridad: "alta" });
    await repo.markDeadlineCompleted(hecho.id, null, "2026-05-30");
    const a = await barrerEscalamientosVencimientos(repo, SESION_NOOP, PROP, "2026-06-10");
    expect(a.escalados.map((e) => e.nivel)).toEqual(["nivel_2"]);
    const b = await barrerEscalamientosVencimientos(repo, SESION_NOOP, PROP, "2026-06-11");
    expect(b.escalados.map((e) => [e.id, e.nivel])).toEqual([[d.id, "nivel_3"]]);
    expect(a.evaluados).toBe(1);
  });
});
