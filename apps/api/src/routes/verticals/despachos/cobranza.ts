// Cobranza automatizada (Fase 10) — hallazgo de auditoría (severidad ALTA):
// "Cobranza tiene motor + persistencia completos pero cero rutas HTTP y cero
// UI". El motor determinista (aging/score de cobrabilidad/proyección/resumen
// ejecutivo, ver `@atiende/domain-despachos::cobranza/engine.ts`) y el
// repositorio (`registerReceivable`/`listReceivables`/`markReceivablePaid`/
// `insertCollectionEvent`/`listCollectionEvents`, migración 004) ya existían
// completos; esta ruta es el primer camino real por el que el staff (nunca
// solo el barrido de worker, ver `apps/worker/src/jobs/despachos/
// cobranza-reminders.ts`) puede operar la cartera. Mismo patrón EXACTO que
// `vencimientos.ts` (leído primero como plantilla): motor puro sin acceso a
// BD + repositorio que persiste + ruta HTTP delgada que solo orquesta.
//
// Ciclo de vida real de una cuenta por cobrar:
//   1. Un invoice tipo 'I' (ingreso) ya ingerido (ver cfdi.ts) arranca su
//      reloj de cobranza -- POST .../cobranza/cuentas (registerReceivable).
//   2. El staff consulta la cartera con aging/score ya calculado -- GET
//      .../cobranza/cuentas (lista) y GET .../cobranza/resumen (ejecutivo,
//      `resumenCobranza`).
//   3. Un recordatorio se dispara SOLO o A MANO -- el barrido automático de
//      worker (`runCobranzaReminderSweep`) ya cubre "hoy toca esta etapa
//      exacta"; esta ruta (.../recordatorio) cubre el caso real que el
//      barrido nunca resuelve: un humano decide mandar un recordatorio FUERA
//      de la fecha exacta de la secuencia (ver `etapaSugeridaPorAtraso`
//      abajo) -- mismo motor de contenido/envío real
//      (`enqueueCollectionReminderEmailCore`) que usa el worker, nunca un
//      camino de envío paralelo.
//   4. Cuando el deudor paga -- POST .../cobranza/cuentas/:id/pagar
//      (markReceivablePaid) cierra el reloj.
import { Hono } from "hono";
import { authMiddleware, assertVerticalRole, dbSession, requirePropertyMembership } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import {
  VER_COBRANZA_ROLES,
  GESTIONAR_COBRANZA_ROLES,
  COBRANZA_REMINDER_SEQUENCE,
  COBRANZA_STAGE_OFFSET_DAYS,
  cobranzaAgeBucket,
  diasVencidoCartera,
  etapaRecordatorioCobranzaHoy,
  scoreCobrabilidadCartera,
  resumenCobranza,
  enqueueCollectionReminderEmailCore,
  ReceivableAlreadyExistsError,
  ReceivableAlreadyPaidError,
} from "@atiende/domain-despachos";
import type { CobranzaReminderStage, CuentaPorCobrarConScore, HistorialCobranzaEntry, InvoiceRecord, ReceivableRecord } from "@atiende/domain-despachos";
import type { DespachosRepository } from "@atiende/domain-despachos";
import { Errors } from "../../../errors.ts";
import { readJsonCapped } from "../../../http-security.ts";
import type { AppDeps } from "../../../deps.ts";

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

const FECHA_ISO_RE = /^\d{4}-\d{2}-\d{2}$/;

function isCobranzaReminderStage(value: unknown): value is CobranzaReminderStage {
  return typeof value === "string" && (COBRANZA_REMINDER_SEQUENCE as readonly string[]).includes(value);
}

/** Sugiere la etapa que corresponde a un envío A MANO fuera de la fecha exacta
 * de la secuencia -- a diferencia de `etapaRecordatorioCobranzaHoy` (que solo
 * acierta EXACTO en -7/0/7/30/60), esto elige la última etapa cuyo offset ya
 * se cumplió (p.ej. 45 días de atraso -> 'segundo_recordatorio', su etapa más
 * reciente vencida), o la primera etapa si la cuenta ni siquiera ha llegado a
 * pre_vencimiento. Solo se usa cuando el caller NO especifica `stage`
 * explícito -- un envío a mano siempre puede pedir cualquier etapa. */
function etapaSugeridaPorAtraso(diasVencido: number): CobranzaReminderStage {
  let chosen: CobranzaReminderStage = COBRANZA_REMINDER_SEQUENCE[0];
  for (const stage of COBRANZA_REMINDER_SEQUENCE) {
    if (COBRANZA_STAGE_OFFSET_DAYS[stage] <= diasVencido) chosen = stage;
  }
  return chosen;
}

async function construirHistorial(repo: DespachosRepository, propertyId: string, receivableId: string): Promise<readonly HistorialCobranzaEntry[]> {
  const eventos = await repo.listCollectionEvents(propertyId, receivableId);
  return eventos.map((e) => ({ tipoRecordatorio: e.etapa, respuesta: e.respuesta }));
}

function serializeReceivable(r: ReceivableRecord, invoice: InvoiceRecord | null, diasVencido: number, score: number) {
  return {
    id: r.id,
    invoiceId: r.invoiceId,
    facturaId: invoice?.folioFiscal ?? null,
    monto: invoice?.total ?? null,
    fechaVencimiento: r.fechaVencimiento,
    diasVencido,
    bucket: cobranzaAgeBucket(diasVencido),
    score,
    clienteNombre: r.clienteNombre,
    clienteEmail: r.clienteEmail,
    montoPagado: r.montoPagado,
    pagadoEn: r.pagadoEn,
    creadoEn: r.createdAt,
  };
}

function serializeEvent(e: { readonly id: string; readonly etapa: string; readonly canal: string; readonly respuesta: string | null; readonly createdAt: string }) {
  return { id: e.id, etapa: e.etapa, canal: e.canal, respuesta: e.respuesta, creadoEn: e.createdAt };
}

interface RegistrarCuentaBody {
  readonly invoiceId?: unknown;
  readonly fechaVencimiento?: unknown;
  readonly clienteNombre?: unknown;
  readonly clienteEmail?: unknown;
}

interface PagarBody {
  readonly montoPagado?: unknown;
  readonly pagadoEn?: unknown;
}

interface RecordatorioBody {
  readonly stage?: unknown;
}

export function despachosCobranzaRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();

  app.use("/despachos/:propertyId/cobranza/*", authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));

  // ---- Lectura de cartera (aging + score ya calculados) ----
  app.get("/despachos/:propertyId/cobranza/cuentas", async (c) => {
    assertVerticalRole(c, VER_COBRANZA_ROLES);
    const repo = deps.despachosRepo(c.get("db"));
    const propertyId = c.req.param("propertyId");
    const pendienteParam = c.req.query("pendiente");
    const filter = pendienteParam === undefined ? undefined : { pendiente: pendienteParam === "true" };
    const today = todayIso();

    const cuentas = await repo.listReceivables(propertyId, filter);
    const serializadas = await Promise.all(
      cuentas.map(async (cuenta) => {
        const [invoice, historial] = await Promise.all([repo.findInvoice(propertyId, cuenta.invoiceId), construirHistorial(repo, propertyId, cuenta.id)]);
        const diasVencido = diasVencidoCartera(cuenta.fechaVencimiento, today);
        const score = cuenta.pagadoEn ? 1 : scoreCobrabilidadCartera(diasVencido, historial);
        return serializeReceivable(cuenta, invoice, diasVencido, score);
      }),
    );
    return c.json(serializadas);
  });

  // ---- Resumen ejecutivo (aging + proyección + alertas + top montos) ----
  app.get("/despachos/:propertyId/cobranza/resumen", async (c) => {
    assertVerticalRole(c, VER_COBRANZA_ROLES);
    const repo = deps.despachosRepo(c.get("db"));
    const propertyId = c.req.param("propertyId");
    const today = todayIso();

    const pendientes = await repo.listReceivables(propertyId, { pendiente: true });
    const cuentas: CuentaPorCobrarConScore[] = await Promise.all(
      pendientes.map(async (cuenta) => {
        const [invoice, historial] = await Promise.all([repo.findInvoice(propertyId, cuenta.invoiceId), construirHistorial(repo, propertyId, cuenta.id)]);
        const diasVencido = diasVencidoCartera(cuenta.fechaVencimiento, today);
        return {
          facturaId: invoice?.folioFiscal ?? cuenta.invoiceId,
          nombreCliente: cuenta.clienteNombre ?? "Cliente sin nombre capturado",
          monto: invoice?.total ?? 0,
          fechaVencimiento: cuenta.fechaVencimiento,
          score: scoreCobrabilidadCartera(diasVencido, historial),
        };
      }),
    );
    return c.json(resumenCobranza(cuentas, today));
  });

  // ---- Arranca el reloj de cobranza de un invoice tipo 'I' ya ingerido ----
  app.post("/despachos/:propertyId/cobranza/cuentas", async (c) => {
    assertVerticalRole(c, GESTIONAR_COBRANZA_ROLES);
    const repo = deps.despachosRepo(c.get("db"));
    const organizationId = c.get("organizationId");
    const propertyId = c.req.param("propertyId");
    const raw = await readJsonCapped<RegistrarCuentaBody>(c.req.raw, 4 * 1024);

    if (typeof raw.invoiceId !== "string" || raw.invoiceId.length === 0) throw Errors.validation("invoiceId: se esperaba un identificador de CFDI ya ingerido.");
    if (typeof raw.fechaVencimiento !== "string" || !FECHA_ISO_RE.test(raw.fechaVencimiento)) throw Errors.validation("fechaVencimiento: se esperaba una fecha 'YYYY-MM-DD'.");
    const clienteNombre = raw.clienteNombre === undefined || raw.clienteNombre === null ? null : typeof raw.clienteNombre === "string" ? raw.clienteNombre : undefined;
    if (clienteNombre === undefined) throw Errors.validation("clienteNombre: se esperaba texto o null.");
    const clienteEmail = raw.clienteEmail === undefined || raw.clienteEmail === null ? null : typeof raw.clienteEmail === "string" ? raw.clienteEmail : undefined;
    if (clienteEmail === undefined) throw Errors.validation("clienteEmail: se esperaba texto o null.");

    const invoice = await repo.findInvoice(propertyId, raw.invoiceId);
    if (!invoice) throw Errors.notFound("El CFDI indicado no existe en esta property.");
    if (invoice.tipo !== "I") throw Errors.validation(`Solo un CFDI de tipo Ingreso ('I') genera una cuenta por cobrar -- este es tipo '${invoice.tipo}'.`);

    try {
      const receivable = await repo.registerReceivable({ organizationId, propertyId, invoiceId: invoice.id, fechaVencimiento: raw.fechaVencimiento, clienteNombre, clienteEmail });
      const diasVencido = diasVencidoCartera(receivable.fechaVencimiento, todayIso());
      return c.json(serializeReceivable(receivable, invoice, diasVencido, scoreCobrabilidadCartera(diasVencido, [])), 201);
    } catch (err) {
      if (err instanceof ReceivableAlreadyExistsError) throw Errors.conflict(`Este CFDI ya tiene una cuenta por cobrar registrada (invoiceId: ${err.message}).`);
      throw err;
    }
  });

  // ---- Detalle de una cuenta ----
  app.get("/despachos/:propertyId/cobranza/cuentas/:receivableId", async (c) => {
    assertVerticalRole(c, VER_COBRANZA_ROLES);
    const repo = deps.despachosRepo(c.get("db"));
    const propertyId = c.req.param("propertyId");
    const receivableId = c.req.param("receivableId");

    const receivable = await repo.findReceivable(propertyId, receivableId);
    if (!receivable) throw Errors.notFound("Cuenta por cobrar no encontrada.");
    const [invoice, eventos, historial] = await Promise.all([repo.findInvoice(propertyId, receivable.invoiceId), repo.listCollectionEvents(propertyId, receivableId), construirHistorial(repo, propertyId, receivableId)]);
    const diasVencido = diasVencidoCartera(receivable.fechaVencimiento, todayIso());
    const score = receivable.pagadoEn ? 1 : scoreCobrabilidadCartera(diasVencido, historial);

    return c.json({
      cuenta: serializeReceivable(receivable, invoice, diasVencido, score),
      eventos: eventos.map(serializeEvent),
    });
  });

  // ---- Historial de eventos de cobranza de una cuenta ----
  app.get("/despachos/:propertyId/cobranza/cuentas/:receivableId/eventos", async (c) => {
    assertVerticalRole(c, VER_COBRANZA_ROLES);
    const repo = deps.despachosRepo(c.get("db"));
    const propertyId = c.req.param("propertyId");
    const receivableId = c.req.param("receivableId");

    const receivable = await repo.findReceivable(propertyId, receivableId);
    if (!receivable) throw Errors.notFound("Cuenta por cobrar no encontrada.");
    const eventos = await repo.listCollectionEvents(propertyId, receivableId);
    return c.json(eventos.map(serializeEvent));
  });

  // ---- Cierra el reloj: marca la cuenta como pagada ----
  app.post("/despachos/:propertyId/cobranza/cuentas/:receivableId/pagar", async (c) => {
    assertVerticalRole(c, GESTIONAR_COBRANZA_ROLES);
    const repo = deps.despachosRepo(c.get("db"));
    const propertyId = c.req.param("propertyId");
    const receivableId = c.req.param("receivableId");
    const raw = await readJsonCapped<PagarBody>(c.req.raw, 1024);

    const montoPagado = raw.montoPagado === undefined || raw.montoPagado === null ? null : typeof raw.montoPagado === "number" && Number.isFinite(raw.montoPagado) ? raw.montoPagado : undefined;
    if (montoPagado === undefined) throw Errors.validation("montoPagado: se esperaba un número o null.");
    const pagadoEn = typeof raw.pagadoEn === "string" && raw.pagadoEn.length > 0 ? raw.pagadoEn : new Date().toISOString();

    const receivable = await repo.findReceivable(propertyId, receivableId);
    if (!receivable) throw Errors.notFound("Cuenta por cobrar no encontrada.");

    try {
      const updated = await repo.markReceivablePaid(propertyId, receivableId, pagadoEn, montoPagado);
      const invoice = await repo.findInvoice(propertyId, updated.invoiceId);
      return c.json(serializeReceivable(updated, invoice, diasVencidoCartera(updated.fechaVencimiento, todayIso()), 1));
    } catch (err) {
      if (err instanceof ReceivableAlreadyPaidError) throw Errors.conflict("Esta cuenta por cobrar ya estaba marcada como pagada.");
      throw err;
    }
  });

  // ---- Envía (a mano) el recordatorio real de una etapa -- mismo motor de
  // contenido/envío que el barrido automático de worker (ver cabecera). ----
  app.post("/despachos/:propertyId/cobranza/cuentas/:receivableId/recordatorio", async (c) => {
    assertVerticalRole(c, GESTIONAR_COBRANZA_ROLES);
    const repo = deps.despachosRepo(c.get("db"));
    const propertyId = c.req.param("propertyId");
    const receivableId = c.req.param("receivableId");
    const raw = await readJsonCapped<RecordatorioBody>(c.req.raw, 1024);

    const receivable = await repo.findReceivable(propertyId, receivableId);
    if (!receivable) throw Errors.notFound("Cuenta por cobrar no encontrada.");
    if (receivable.pagadoEn !== null) throw Errors.conflict("Esta cuenta ya está pagada; no se envían más recordatorios.");

    const invoice = await repo.findInvoice(propertyId, receivable.invoiceId);
    if (!invoice) throw Errors.conflict("El CFDI asociado a esta cuenta por cobrar ya no existe -- dato inconsistente, no se puede generar el recordatorio.");

    if (raw.stage !== undefined && !isCobranzaReminderStage(raw.stage)) throw Errors.validation(`stage: se esperaba una de ${COBRANZA_REMINDER_SEQUENCE.join(", ")}.`);
    const today = todayIso();
    const diasVencido = diasVencidoCartera(receivable.fechaVencimiento, today);
    const stage: CobranzaReminderStage = isCobranzaReminderStage(raw.stage) ? raw.stage : (etapaRecordatorioCobranzaHoy(receivable.fechaVencimiento, today) ?? etapaSugeridaPorAtraso(diasVencido));

    const resultado = await enqueueCollectionReminderEmailCore(repo, receivable, { facturaId: invoice.folioFiscal, monto: invoice.total }, stage, diasVencido);
    return c.json({ etapa: stage, diasVencido, enviado: resultado.enqueued, motivo: resultado.reason ?? null }, 201);
  });

  return app;
}
