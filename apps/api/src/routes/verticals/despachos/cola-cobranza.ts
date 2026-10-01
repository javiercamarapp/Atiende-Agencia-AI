// D-11 -- cola de cobranza del despacho. Todo cuelga de `/despachos/:propertyId/cola-cobranza/*` (staff:
// authMiddleware + dbSession + requirePropertyMembership):
//
//   GET  .../gestiones?receivableId=&estado=          gestiones (promesa de pago, recordatorio, llamada, nota)
//   POST .../gestiones                                registra una gestion sobre una cuenta por cobrar (factura)
//   POST .../gestiones/:gestionId/estado              resuelve una gestion pendiente (cumplida/incumplida/cancelada)
//   GET  .../cola                                     gestiones pendientes de cuentas vivas, por urgencia
//   GET  .../reporte-cartera?formato=json|pdf         cartera y antiguedad de saldos por cliente (corte = hoy)
//   GET  .../whatsapp/consentimientos                 consentimiento opt-in/opt-out por cliente (RFC), telefono enmascarado
//   POST .../whatsapp/consentimientos                 { rfcReceptor, telefono, estado, evidencia? } (upsert por cliente)
//   POST .../cuentas/:receivableId/whatsapp           ENCOLA un recordatorio (nunca envia) si hay opt-in
//   GET  .../whatsapp/outbox                          mensajes en cola
//
// Reutiliza lo ya existente en lugar de duplicarlo: la cartera (`receivable`/`invoice` via DespachosRepository),
// las plantillas de recordatorio del motor de cobranza y el render PDF de `reporte-pdf.ts` (pdf-lib, sin ejecutar
// nada del usuario). Montos en centavos enteros MXN; "hoy" en la zona horaria de la property (por omision
// America/Mexico_City).
//
// NO ENVIA WhatsApp: el mensaje queda en `despachos.cobranza_whatsapp_outbox` en estado `pendiente`; ningun
// proceso del repo lo despacha todavia (no hay credencial de WhatsApp para despachos). Las respuestas lo dicen.
//
// Compatibilidad con la base sin migrar (017 pendiente): las lecturas responden `disponible: false` con listas
// vacias, las escrituras 503 honesto, y el reporte de cartera sigue funcionando (solo lee tablas ya existentes).
import { Hono } from "hono";
import { authMiddleware, assertVerticalRole, dbSession, requirePropertyMembership } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { hoyFechaNegocio } from "@atiende/core-tenancy";
import type { TenantDbSession } from "@atiende/core-tenancy";
import {
  ColaCuotaExcedidaError,
  ColaEntradaInvalidaError,
  ColaEstadoInvalidoError,
  ColaNoEncontradaError,
  ColaSinAccesoError,
  ColaSinConsentimientoError,
  COBRANZA_REMINDER_SEQUENCE,
  GESTIONAR_COLA_COBRANZA_ROLES,
  GESTION_ESTADOS,
  GESTION_ESTADOS_RESOLUCION,
  PostgresColaCobranzaRepository,
  VER_COLA_COBRANZA_ROLES,
  construirMensajeWhatsApp,
  construirReporteCartera,
  dedupeKeyWhatsApp,
  diasVencidoCartera,
  esGestionTipo,
  normalizarRfc,
  normalizarTelefono,
  ordenarCola,
  pesosACentavos,
  validarNuevaGestion,
} from "@atiende/domain-despachos";
import type {
  CobranzaReminderStage,
  ColaCobranzaRepository,
  ColaDisponible,
  CuentaCartera,
  DespachosRepository,
  GestionEstado,
  GestionEstadoResolucion,
  InvoiceRecord,
  ReceivableRecord,
} from "@atiende/domain-despachos";
import { Errors } from "../../../errors.ts";
import { readJsonCapped } from "../../../http-security.ts";
import type { AppDeps } from "../../../deps.ts";
import { etapaSugeridaPorAtraso } from "./cobranza.ts";
import { reporteAPdf } from "./reporte-pdf.ts";
import { resolverZonaHorariaDespachosProperty } from "./zona-horaria.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_EVIDENCIA = 300;
const MSG_NO_DISPONIBLE = "La cola de cobranza aún no está disponible en este ambiente (migración 017 pendiente).";

function requireUuid(valor: string | undefined, campo: string): string {
  if (!valor || !UUID_RE.test(valor)) throw Errors.validation(`${campo}: se esperaba un UUID.`);
  return valor;
}

function exigirDisponible<T>(r: ColaDisponible<T>): T {
  if (!r.disponible) throw Errors.serviceUnavailable(MSG_NO_DISPONIBLE);
  return r.valor;
}

/** Errores de dominio -> HTTP, sin filtrar mensajes de Postgres. */
function traducirError(err: unknown): unknown {
  if (err instanceof ColaEntradaInvalidaError) return Errors.validation(err.message);
  if (err instanceof ColaNoEncontradaError) return Errors.notFound("No se encontró el registro indicado en esta cuenta.");
  if (err instanceof ColaSinAccesoError) return Errors.forbidden();
  if (err instanceof ColaCuotaExcedidaError) return Errors.tooManyRequests("Se alcanzó el límite permitido de registros para esta cuenta.");
  if (err instanceof ColaEstadoInvalidoError) return Errors.conflict("La gestión ya estaba resuelta.");
  if (err instanceof ColaSinConsentimientoError) return Errors.conflict("El cliente no tiene consentimiento opt-in vigente para recibir WhatsApp. Regístralo primero.");
  return err;
}

async function conTraduccion<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw traducirError(err);
  }
}

function enmascararTelefono(telefono: string): string {
  return `${telefono.slice(0, 3)}${"*".repeat(Math.max(0, telefono.length - 7))}${telefono.slice(-4)}`;
}

function textoOpcional(valor: unknown, campo: string): string | null {
  if (valor === undefined || valor === null) return null;
  if (typeof valor !== "string") throw Errors.validation(`${campo}: se esperaba texto o null.`);
  const limpio = valor.trim();
  return limpio === "" ? null : limpio;
}

interface Cartera {
  readonly cuentas: readonly ReceivableRecord[];
  readonly invoices: ReadonlyMap<string, InvoiceRecord>;
}

/** Cartera pendiente + sus CFDI en 2 consultas agregadas (sin 1+N), reutilizando el repositorio existente. */
async function leerCarteraPendiente(repo: DespachosRepository, propertyId: string): Promise<Cartera> {
  const cuentas = await repo.listReceivables(propertyId, { pendiente: true });
  const invoices = await repo.findInvoicesByIds(propertyId, [...new Set(cuentas.map((c) => c.invoiceId))]);
  return { cuentas, invoices: new Map(invoices.map((i) => [i.id, i])) };
}

export function despachosColaCobranzaRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();
  const colaDe = (db: TenantDbSession): ColaCobranzaRepository => (deps.colaCobranzaRepo ? deps.colaCobranzaRepo(db) : new PostgresColaCobranzaRepository(db));

  app.use("/despachos/:propertyId/cola-cobranza/*", authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));

  // ------------------------------------------------------------------ gestiones
  app.get("/despachos/:propertyId/cola-cobranza/gestiones", async (c) => {
    assertVerticalRole(c, VER_COLA_COBRANZA_ROLES);
    const propertyId = c.req.param("propertyId");
    const receivableId = c.req.query("receivableId");
    const estado = c.req.query("estado");
    if (receivableId !== undefined) requireUuid(receivableId, "receivableId");
    if (estado !== undefined && !(GESTION_ESTADOS as readonly string[]).includes(estado)) throw Errors.validation(`estado: se esperaba uno de ${GESTION_ESTADOS.join(", ")}.`);
    const r = await conTraduccion(() => colaDe(c.get("db")).listarGestiones(propertyId, { receivableId, estado: estado as GestionEstado | undefined }));
    return c.json({ disponible: r.disponible, gestiones: r.disponible ? r.valor : [] });
  });

  app.post("/despachos/:propertyId/cola-cobranza/gestiones", async (c) => {
    assertVerticalRole(c, GESTIONAR_COLA_COBRANZA_ROLES);
    const propertyId = c.req.param("propertyId");
    const raw = await readJsonCapped<Record<string, unknown>>(c.req.raw, 4 * 1024);
    const receivableId = requireUuid(typeof raw.receivableId === "string" ? raw.receivableId : undefined, "receivableId");
    if (!esGestionTipo(raw.tipo)) throw Errors.validation("tipo: se esperaba promesa_pago, recordatorio, llamada o nota.");
    const nota = textoOpcional(raw.nota, "nota");
    const monto = raw.montoPromesaCentavos === undefined || raw.montoPromesaCentavos === null ? null : raw.montoPromesaCentavos;
    if (monto !== null && typeof monto !== "number") throw Errors.validation("montoPromesaCentavos: se esperaba un entero en centavos MXN.");
    const fechaPromesa = textoOpcional(raw.fechaPromesa, "fechaPromesa");
    const fechaSeguimiento = textoOpcional(raw.fechaSeguimiento, "fechaSeguimiento");

    const repo = deps.despachosRepo(c.get("db"));
    const hoy = hoyFechaNegocio(await resolverZonaHorariaDespachosProperty(repo, propertyId));
    const entrada = { receivableId, tipo: raw.tipo, nota, montoPromesaCentavos: monto, fechaPromesa, fechaSeguimiento };
    const motivo = validarNuevaGestion(entrada, hoy);
    if (motivo !== null) throw Errors.validation(motivo);
    const receivable = await repo.findReceivable(propertyId, receivableId);
    if (!receivable) throw Errors.notFound("Cuenta por cobrar no encontrada.");
    if (raw.tipo === "promesa_pago" && receivable.pagadoEn !== null) throw Errors.conflict("Esta cuenta ya está pagada; no admite promesas de pago.");

    const r = await conTraduccion(() => colaDe(c.get("db")).crearGestion({ propertyId, ...entrada }));
    return c.json({ id: exigirDisponible(r).id }, 201);
  });

  app.post("/despachos/:propertyId/cola-cobranza/gestiones/:gestionId/estado", async (c) => {
    assertVerticalRole(c, GESTIONAR_COLA_COBRANZA_ROLES);
    const propertyId = c.req.param("propertyId");
    const gestionId = requireUuid(c.req.param("gestionId"), "gestionId");
    const raw = await readJsonCapped<Record<string, unknown>>(c.req.raw, 4 * 1024);
    if (typeof raw.estado !== "string" || !(GESTION_ESTADOS_RESOLUCION as readonly string[]).includes(raw.estado)) throw Errors.validation(`estado: se esperaba uno de ${GESTION_ESTADOS_RESOLUCION.join(", ")}.`);
    const nota = textoOpcional(raw.nota, "nota");
    if (nota !== null && nota.length > 1000) throw Errors.validation("nota: admite hasta 1000 caracteres.");
    const r = await conTraduccion(() => colaDe(c.get("db")).resolverGestion(propertyId, gestionId, raw.estado as GestionEstadoResolucion, nota));
    exigirDisponible(r);
    return c.json({ id: gestionId, estado: raw.estado });
  });

  // ------------------------------------------------------------------ cola
  app.get("/despachos/:propertyId/cola-cobranza/cola", async (c) => {
    assertVerticalRole(c, VER_COLA_COBRANZA_ROLES);
    const propertyId = c.req.param("propertyId");
    const repo = deps.despachosRepo(c.get("db"));
    const hoy = hoyFechaNegocio(await resolverZonaHorariaDespachosProperty(repo, propertyId));
    const r = await conTraduccion(() => colaDe(c.get("db")).listarGestiones(propertyId, { estado: "pendiente" }));
    if (!r.disponible) return c.json({ disponible: false, hoy, items: [] });

    const cartera = await leerCarteraPendiente(repo, propertyId);
    const cuentasPorId = new Map(cartera.cuentas.map((cu) => [cu.id, cu]));
    // Una gestion de una cuenta ya pagada no entra a la cola de trabajo (ya no hay nada que cobrar).
    const conCuenta = r.valor.flatMap((gestion) => {
      const cuenta = cuentasPorId.get(gestion.receivableId);
      return cuenta ? [{ gestion, cuenta }] : [];
    });
    const items = ordenarCola(conCuenta, hoy).map(({ urgencia, item }) => {
      const invoice = cartera.invoices.get(item.cuenta.invoiceId) ?? null;
      return {
        urgencia,
        gestion: item.gestion,
        cuenta: {
          id: item.cuenta.id,
          folioFiscal: invoice?.folioFiscal ?? null,
          rfcReceptor: invoice?.rfcReceptor ?? null,
          clienteNombre: item.cuenta.clienteNombre,
          saldoCentavos: invoice ? pesosACentavos(invoice.total) : null,
          fechaVencimiento: item.cuenta.fechaVencimiento,
          diasVencido: diasVencidoCartera(item.cuenta.fechaVencimiento, hoy),
        },
      };
    });
    return c.json({ disponible: true, hoy, items });
  });

  // ------------------------------------------------------------------ reporte de cartera / antiguedad
  app.get("/despachos/:propertyId/cola-cobranza/reporte-cartera", async (c) => {
    assertVerticalRole(c, VER_COLA_COBRANZA_ROLES);
    const formato = c.req.query("formato") ?? "json";
    if (formato !== "json" && formato !== "pdf") throw Errors.validation("formato: se esperaba json o pdf.");
    const propertyId = c.req.param("propertyId");
    const repo = deps.despachosRepo(c.get("db"));
    const hoy = hoyFechaNegocio(await resolverZonaHorariaDespachosProperty(repo, propertyId));
    const cartera = await leerCarteraPendiente(repo, propertyId);
    const cuentas: CuentaCartera[] = cartera.cuentas.flatMap((cu) => {
      const invoice = cartera.invoices.get(cu.invoiceId);
      if (!invoice) return []; // dato inconsistente (CFDI borrado): sin monto no hay saldo que reportar
      return [{ folioFiscal: invoice.folioFiscal, rfcReceptor: invoice.rfcReceptor, clienteNombre: cu.clienteNombre, saldoCentavos: pesosACentavos(invoice.total), fechaVencimiento: cu.fechaVencimiento }];
    });
    const sucursales = await repo.listPropertiesForOrganization(c.get("organizationId"));
    const nombre = sucursales.find((s) => s.propertyId === propertyId)?.name ?? "Contribuyente";
    const emisores = new Set([...cartera.invoices.values()].map((i) => i.rfcEmisor));
    const reporte = construirReporteCartera({ cuentas, hoy, contribuyente: { nombre, rfc: emisores.size === 1 ? [...emisores][0]! : null } });

    if (formato === "json") return c.json(reporte);
    return new Response(await reporteAPdf(reporte), {
      headers: { "content-type": "application/pdf", "content-disposition": `attachment; filename="cartera-antiguedad-${hoy}.pdf"`, "cache-control": "private, no-store", "x-content-type-options": "nosniff" },
    });
  });

  // ------------------------------------------------------------------ WhatsApp (opt-in/opt-out + outbox sin envio)
  app.get("/despachos/:propertyId/cola-cobranza/whatsapp/consentimientos", async (c) => {
    assertVerticalRole(c, VER_COLA_COBRANZA_ROLES);
    const r = await conTraduccion(() => colaDe(c.get("db")).listarConsentimientos(c.req.param("propertyId")));
    return c.json({
      disponible: r.disponible,
      consentimientos: r.disponible ? r.valor.map((x) => ({ rfcReceptor: x.rfcReceptor, telefono: enmascararTelefono(x.telefono), estado: x.estado, evidencia: x.evidencia, actualizadoEn: x.actualizadoEn })) : [],
    });
  });

  app.post("/despachos/:propertyId/cola-cobranza/whatsapp/consentimientos", async (c) => {
    assertVerticalRole(c, GESTIONAR_COLA_COBRANZA_ROLES);
    const propertyId = c.req.param("propertyId");
    const raw = await readJsonCapped<Record<string, unknown>>(c.req.raw, 4 * 1024);
    const rfc = typeof raw.rfcReceptor === "string" ? normalizarRfc(raw.rfcReceptor) : null;
    if (rfc === null) throw Errors.validation("rfcReceptor: se esperaba un RFC válido.");
    const telefono = typeof raw.telefono === "string" ? normalizarTelefono(raw.telefono) : null;
    if (telefono === null) throw Errors.validation("telefono: se esperaba un número válido (10 dígitos MX o formato internacional +...).");
    if (raw.estado !== "opt_in" && raw.estado !== "opt_out") throw Errors.validation("estado: se esperaba opt_in u opt_out.");
    const evidencia = textoOpcional(raw.evidencia, "evidencia");
    if (evidencia !== null && evidencia.length > MAX_EVIDENCIA) throw Errors.validation(`evidencia: admite hasta ${MAX_EVIDENCIA} caracteres.`);
    if (raw.estado === "opt_in" && evidencia === null) throw Errors.validation("evidencia: el opt-in exige indicar cómo se obtuvo el consentimiento del cliente.");
    const r = await conTraduccion(() => colaDe(c.get("db")).fijarConsentimiento({ propertyId, rfcReceptor: rfc, telefono, estado: raw.estado as "opt_in" | "opt_out", evidencia }));
    exigirDisponible(r);
    return c.json({ rfcReceptor: rfc, estado: raw.estado });
  });

  app.post("/despachos/:propertyId/cola-cobranza/cuentas/:receivableId/whatsapp", async (c) => {
    assertVerticalRole(c, GESTIONAR_COLA_COBRANZA_ROLES);
    const propertyId = c.req.param("propertyId");
    const receivableId = requireUuid(c.req.param("receivableId"), "receivableId");
    const raw = await readJsonCapped<Record<string, unknown>>(c.req.raw, 1024);
    if (raw.etapa !== undefined && (typeof raw.etapa !== "string" || !(COBRANZA_REMINDER_SEQUENCE as readonly string[]).includes(raw.etapa))) {
      throw Errors.validation(`etapa: se esperaba una de ${COBRANZA_REMINDER_SEQUENCE.join(", ")}.`);
    }
    const repo = deps.despachosRepo(c.get("db"));
    const receivable = await repo.findReceivable(propertyId, receivableId);
    if (!receivable) throw Errors.notFound("Cuenta por cobrar no encontrada.");
    if (receivable.pagadoEn !== null) throw Errors.conflict("Esta cuenta ya está pagada; no se encolan más recordatorios.");
    const invoice = await repo.findInvoice(propertyId, receivable.invoiceId);
    if (!invoice) throw Errors.conflict("El CFDI asociado a esta cuenta ya no existe; no se puede generar el recordatorio.");

    const hoy = hoyFechaNegocio(await resolverZonaHorariaDespachosProperty(repo, propertyId));
    const diasVencido = diasVencidoCartera(receivable.fechaVencimiento, hoy);
    const etapa: CobranzaReminderStage = (raw.etapa as CobranzaReminderStage | undefined) ?? etapaSugeridaPorAtraso(diasVencido);
    const cuerpo = construirMensajeWhatsApp({ facturaId: invoice.folioFiscal, nombreCliente: receivable.clienteNombre ?? "cliente", saldoCentavos: pesosACentavos(invoice.total), diasVencido, etapa });
    const r = await conTraduccion(() => colaDe(c.get("db")).encolarWhatsApp({ propertyId, receivableId, cuerpo, dedupeKey: dedupeKeyWhatsApp(receivableId, etapa, hoy) }));
    const { id, duplicado } = exigirDisponible(r);
    return c.json({ id, etapa, diasVencido, duplicado, estado: "pendiente", enviado: false, nota: "Mensaje en cola. El envío por WhatsApp aún no está habilitado: nada se ha enviado al cliente." }, duplicado ? 200 : 201);
  });

  app.get("/despachos/:propertyId/cola-cobranza/whatsapp/outbox", async (c) => {
    assertVerticalRole(c, VER_COLA_COBRANZA_ROLES);
    const r = await conTraduccion(() => colaDe(c.get("db")).listarOutbox(c.req.param("propertyId")));
    return c.json({ disponible: r.disponible, mensajes: r.disponible ? r.valor : [] });
  });

  return app;
}
