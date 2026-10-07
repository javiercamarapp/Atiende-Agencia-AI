// Fixtures de hoteles (Hotel Casa Azul). Forma = apps/web/src/verticals/hoteles/lib/*-client.ts.
import { conStatus, fallo, ndjson } from "../respuestas.ts";
import { orgDe, propiedadDe } from "../personas.ts";
import type { Ruta } from "../tipos.ts";

const PROP = propiedadDe("hoteles");
const ORG = orgDe("hoteles");
const H = "/hoteles/:id";

function ticketsSemilla() {
  const ahora = Date.now();
  return [
    { id: "tkt-1", habitacion: "204", resenaId: null, departamento: "housekeeping", prioridad: "media", estado: "abierto", canal: "recepcion", mensaje: "Faltan toallas en la habitacion 204", slaMinutos: 60, slaVenceEn: new Date(ahora + 40 * 60_000).toISOString(), estadoSla: "en_tiempo", minutosParaVencer: 40, asignadoA: null, escaladoEn: null, escaladoARoles: [], notaResolucion: null, creadoEn: new Date(ahora - 20 * 60_000).toISOString() },
    { id: "tkt-2", habitacion: "112", resenaId: null, departamento: "maintenance", prioridad: "alta", estado: "en_progreso", canal: "huesped", mensaje: "El aire acondicionado de la 112 no enfria", slaMinutos: 120, slaVenceEn: new Date(ahora + 15 * 60_000).toISOString(), estadoSla: "por_vencer", minutosParaVencer: 15, asignadoA: "Equipo de mantenimiento", escaladoEn: null, escaladoARoles: [], notaResolucion: null, creadoEn: new Date(ahora - 105 * 60_000).toISOString() },
  ];
}

type Ticket = ReturnType<typeof ticketsSemilla>[number];

const ESTADO_POR_ACCION: Record<string, string> = { iniciar: "en_progreso", cerrar: "cerrado", cancelar: "cancelado", escalar: "escalado" };

// CHAT-09 -- Copiloto ("Pregunta a tus datos"): respuesta fija en el formato REAL del servidor (NDJSON paso/fin con conversacionId y
// seq; conversaciones guardadas por escenario). Solo owner/gm lo usan en el servidor real; en e2e la persona "owner" es el unico rol con acceso.
// Solo existe en la API simulada de e2e.
interface ConversacionMock {
  id: string;
  titulo: string;
  actualizadaEn: string;
  mensajes: { id: string; role: "user" | "assistant"; text: string; status?: string; blocks?: unknown[]; sources?: unknown[]; seq: number }[];
}
const MOCK_ROLES_COPILOTO = ["owner"] as const;
const BLOQUE_OCUPACION = {
  kind: "table",
  tool: "ocupacion_adr_revpar",
  title: "Ocupación, ADR y RevPAR",
  columns: [
    { key: "periodo", label: "Día", kind: "text" },
    { key: "ocupacion", label: "Ocupación", kind: "percent" },
    { key: "adr", label: "ADR", kind: "mxn" },
  ],
  rows: ["Lun", "Mar", "Mié", "Jue", "Vie", "Sáb", "Dom"].map((periodo, i) => ({ periodo, ocupacion: 58 + i * 5, adr: 1450 + i * 40 })),
  chart: { kind: "line", x: "periodo", y: "ocupacion" },
  truncated: false,
};
const TEXTO_OCUPACION = "Esta semana tu ocupación fue 73% (255 de 350 noches); ADR $1,570 MXN.";
const FUENTE_OCUPACION = { tool: "ocupacion_adr_revpar", source: "Cargos de hospedaje del folio e inventario por día", periodLabel: "esta semana (lunes a hoy)", scopeLabel: "todos tus hoteles" };
const conversacionesMock = (p: { estado: { obtener<T>(k: string, s: () => T): T } }) => p.estado.obtener<ConversacionMock[]>("hoteles.copiloto.conversaciones", () => []);

export const rutasHoteles: readonly Ruta[] = [
  { metodo: "GET", patron: `${H}/chat-datos/pins`, roles: MOCK_ROLES_COPILOTO, manejador: () => ({ disponible: true, pins: [] }) },
  { metodo: "GET", patron: `${H}/chat-datos/estado`, roles: MOCK_ROLES_COPILOTO, manejador: () => ({ available: true, permitido: true, motivo: null, usoHoyPct: 0 }) },
  {
    metodo: "POST",
    patron: `${H}/chat-datos`,
    roles: MOCK_ROLES_COPILOTO,
    manejador: (p) => {
      const cuerpo = (p.cuerpo ?? {}) as { question?: string; label?: string; conversationId?: string };
      const pregunta = String(cuerpo.question ?? cuerpo.label ?? "");
      const lista = conversacionesMock(p);
      let conv = lista.find((c) => c.id === cuerpo.conversationId);
      if (!conv) {
        conv = { id: `00000000-0000-4000-8000-${String(lista.length + 1).padStart(12, "0")}`, titulo: pregunta.slice(0, 60), actualizadaEn: new Date().toISOString(), mensajes: [] };
        lista.unshift(conv);
      }
      const seq = conv.mensajes.length + 2;
      conv.mensajes.push({ id: `m-${seq - 1}`, role: "user", text: pregunta, seq: seq - 1 });
      conv.mensajes.push({ id: `m-${seq}`, role: "assistant", text: TEXTO_OCUPACION, status: "ok", blocks: [BLOQUE_OCUPACION], sources: [FUENTE_OCUPACION], seq });
      conv.actualizadaEn = new Date().toISOString();
      return ndjson([
        { t: "paso", fase: "inicio", herramienta: "ocupacion_adr_revpar" },
        { t: "paso", fase: "fin", herramienta: "ocupacion_adr_revpar" },
        { t: "fin", conversacionId: conv.id, seq, respuesta: { status: "ok", text: TEXTO_OCUPACION, blocks: [BLOQUE_OCUPACION], sources: [FUENTE_OCUPACION], toolsUsed: ["ocupacion_adr_revpar"] } },
      ]);
    },
  },
  { metodo: "GET", patron: `${H}/chat-datos/conversaciones`, roles: MOCK_ROLES_COPILOTO, manejador: (p) => ({ disponible: true, conversaciones: conversacionesMock(p).map((c) => ({ id: c.id, titulo: c.titulo, actualizadaEn: c.actualizadaEn, mensajes: c.mensajes.length })) }) },
  { metodo: "GET", patron: `${H}/chat-datos/conversaciones/:cid`, roles: MOCK_ROLES_COPILOTO, manejador: (p) => conversacionesMock(p).find((c) => c.id === p.params["cid"]) ?? fallo(404, "Conversación no encontrada.") },
  {
    metodo: "PATCH",
    patron: `${H}/chat-datos/conversaciones/:cid`,
    roles: MOCK_ROLES_COPILOTO,
    manejador: (p) => {
      const c = conversacionesMock(p).find((x) => x.id === p.params["cid"]);
      if (!c) return fallo(404, "Conversación no encontrada.");
      c.titulo = String(((p.cuerpo ?? {}) as { titulo?: string }).titulo ?? c.titulo);
      return { id: c.id, titulo: c.titulo };
    },
  },
  {
    metodo: "DELETE",
    patron: `${H}/chat-datos/conversaciones/:cid`,
    roles: MOCK_ROLES_COPILOTO,
    manejador: (p) => {
      const lista = conversacionesMock(p);
      const i = lista.findIndex((x) => x.id === p.params["cid"]);
      if (i < 0) return fallo(404, "Conversación no encontrada.");
      lista.splice(i, 1);
      return conStatus(204, undefined);
    },
  },
  // UNI-RES-hoteles -- datos del Resumen (forma = apps/web/src/verticals/hoteles/lib/{pl,recepcion,agentes,reservas-agente,night-audit}-client.ts).
  // Forma COMPLETA de `GET .../pl` (PlFullResponse): la sirven tanto el Resumen (kpis + total) como la pagina de P&L (departamentos, equilibrio).
  { metodo: "GET", patron: `${H}/pl`, roles: ["owner"], manejador: () => ({
    periodo: { desde: "2026-09-03", hasta: "2026-10-02" },
    total: {
      departamentos: [{ department: "rooms", revenue: 304500, costOfSales: 0, payroll: 60900, otherExpenses: 30450, totalExpenses: 91350, departmentalProfit: 213150, profitMarginPct: 70 }],
      ingresosTotales: 304500, utilidadDepartamentalTotal: 213150, gastosNoDistribuidos: [{ department: "admin_general", amount: 91350 }], totalGastosNoDistribuidos: 91350,
      gop: 121800, gopMarginPct: 40, cuotaAdministracion: 12180, ebitda: 109620, gastosNoOperativos: 18270, utilidadNeta: 91350,
    },
    kpis: { adr: 1450, revpar: 1015, occupancyPct: 70, occupiedRoomNights: 210, availableRoomNights: 300 },
    puntoEquilibrio: { fixedCostsNetOfOtherDepartments: 91350, contributionMarginPerRoom: 1160, breakevenOccupiedRoomNights: 79, breakevenOccupancyPct: 26.3, actualOccupancyPct: 70, occupancyGapPct: 43.7 },
    ownersReport: { porEncimaDePuntoDeEquilibrio: true, alertas: [] },
    alcance: { pendiente: [] },
  }) },
  { metodo: "GET", patron: `${H}/recepcion`, roles: ["owner"], manejador: () => ({ fecha: "2026-10-02", tareasDisponibles: true, identidadDisponible: true, resumen: { llegadas: 4, llegadasPendientes: 3, salidas: 2, salidasPendientes: 1, enCasa: 17, habitacionesLibres: 6, habitacionesSucias: 2, habitacionesFueraDeServicio: 1 }, llegadas: [], salidas: [], enCasa: [], rack: [] }) },
  { metodo: "GET", patron: `${H}/aprobaciones`, roles: ["owner"], manejador: () => ({ disponible: true, ahora: new Date().toISOString(), aprobaciones: [{ id: "apr-1", estado: "pendiente" }, { id: "apr-2", estado: "ejecutada" }] }) },
  { metodo: "GET", patron: `${H}/reservas-agente/holds`, roles: ["owner"], manejador: () => ({ disponible: true, holds: [{ id: "hold-1", estado: "pendiente_pago", canal: "whatsapp" }, { id: "hold-2", estado: "pendiente_aprobacion", canal: "voz" }] }) },
  { metodo: "GET", patron: `${H}/agentes`, roles: ["owner"], manejador: () => ({ disponible: true, mes: "2026-10", agentes: [
    { clave: "recepcion_whatsapp", nombre: "Agente de reservas por WhatsApp y voz", descripcion: "", gobernado: true, activo: true, estado: "activo", motivoPausa: null, pausadoEn: null, presupuestoUsd: 80, gastoUsd: 12.4, porcentajeUso: 15.5, llamadas: 132, tokensEntrada: 0, tokensSalida: 0 },
    { clave: "revenue", nombre: "Agente de revenue", descripcion: "", gobernado: true, activo: false, estado: "pausado", motivoPausa: null, pausadoEn: null, presupuestoUsd: null, gastoUsd: 0, porcentajeUso: null, llamadas: 0, tokensEntrada: 0, tokensSalida: 0 },
    { clave: "reputacion", nombre: "Agente de reputación", descripcion: "", gobernado: true, activo: true, estado: "activo", motivoPausa: null, pausadoEn: null, presupuestoUsd: 30, gastoUsd: 3.1, porcentajeUso: 10.3, llamadas: 18, tokensEntrada: 0, tokensSalida: 0 },
    { clave: "mantenimiento", nombre: "Agente de mantenimiento", descripcion: "", gobernado: true, activo: true, estado: "activo", motivoPausa: null, pausadoEn: null, presupuestoUsd: null, gastoUsd: 0.4, porcentajeUso: null, llamadas: 5, tokensEntrada: 0, tokensSalida: 0 },
  ] }) },
  { metodo: "GET", patron: `${H}/night-audit`, roles: ["owner"], manejador: () => [{ fecha: "2026-10-01", estado: "completado", completadoEn: "2026-10-02T07:30:00.000Z" }, { fecha: "2026-09-30", estado: "completado", completadoEn: "2026-10-01T07:30:00.000Z" }] },
  { metodo: "GET", patron: "/v1/hoteles/:org/admin/propiedades", manejador: () => ({ propiedades: [{ propertyId: PROP.id, nombre: PROP.nombre }] }) },
  // Rutas especificas antes que `:tid` (el router toma la primera que coincide).
  { metodo: "GET", patron: `${H}/tickets/resenas-pendientes`, manejador: () => ({ disponible: true, resenas: [] }) },
  { metodo: "GET", patron: `${H}/tickets/sla`, manejador: () => ({ disponible: true, efectiva: [{ departamento: "housekeeping", prioridad: "media", minutos: 60, configurada: false }] }) },
  { metodo: "GET", patron: `${H}/tickets`, manejador: (p) => {
      const todos = p.estado.obtener<Ticket[]>("hoteles.tickets", ticketsSemilla);
      const activos = p.query.get("activos") === "1";
      return { disponible: true, ahora: new Date().toISOString(), tickets: activos ? todos.filter((t) => t.estado !== "cerrado" && t.estado !== "cancelado") : todos };
    } },
  { metodo: "POST", patron: `${H}/tickets/:tid/:accion`, manejador: (p) => {
      const t = p.estado.obtener<Ticket[]>("hoteles.tickets", ticketsSemilla).find((x) => x.id === p.params.tid);
      const estado = ESTADO_POR_ACCION[p.params.accion ?? ""];
      if (!t || !estado) return fallo(404, "Ticket o accion desconocidos");
      t.estado = estado;
      return t;
    } },
  // H-P3-01 -- folio con estado en el escenario: un cierre se refleja en el siguiente GET y un cargo/pago/cierre posterior recibe el mismo
  // 409 legible que la API real (el trigger de la migracion 045 + el onError de apps/api/.../hoteles/folios.ts). Solo existe en la API simulada.
  { metodo: "GET", patron: `${H}/folios/:fid`, manejador: (p) => {
      const f = folioMock(p);
      return p.params.fid === f.id ? serializarFolio(f) : fallo(404, "Folio no encontrado.");
    } },
  { metodo: "GET", patron: `${H}/reservas/:rid/folios`, manejador: (p) => [serializarFolio(folioMock(p))] },
  { metodo: "POST", patron: `${H}/folios/:fid/cargos`, manejador: (p) => {
      const f = folioMock(p);
      if (f.estado !== "abierto") return fallo(409, MENSAJE_FOLIO_CERRADO);
      const cuerpo = (p.cuerpo ?? {}) as { descripcion?: string; monto?: number; concepto?: ConceptoMock };
      const monto = Number(cuerpo.monto);
      if (!cuerpo.descripcion || !Number.isFinite(monto) || monto <= 0) return fallo(400, "Descripcion y monto (> 0) son requeridos.");
      const cargo = { id: `chg-${f.cargos.length + 1}`, concepto: cuerpo.concepto ?? "extras", descripcion: cuerpo.descripcion, monto, impuesto: Math.round(monto * 16) / 100, revertidoPor: null, reversaDe: null, transferidoDe: null, creadoEn: new Date().toISOString() };
      f.cargos.push(cargo);
      return conStatus(201, { id: cargo.id, concepto: cargo.concepto, monto: cargo.monto, impuesto: cargo.impuesto });
    } },
  { metodo: "POST", patron: `${H}/folios/:fid/cerrar`, manejador: (p) => {
      const f = folioMock(p);
      if (f.estado !== "abierto") return fallo(409, "El folio ya está cerrado.");
      const motivo = ((p.cuerpo ?? {}) as { motivo?: string }).motivo;
      if (motivo !== "saldo_cero" && motivo !== "cuenta_por_cobrar") return fallo(400, "motivo: se esperaba saldo_cero|cuenta_por_cobrar.");
      const saldo = saldoFolio(f);
      if (motivo === "saldo_cero" && saldo !== 0) return fallo(409, "El saldo del folio cambió y ya no es cero: revisa el folio antes de cerrarlo.");
      f.estado = "cerrado";
      f.motivoCierre = motivo;
      f.cerradoEn = new Date().toISOString();
      return { id: f.id, estado: f.estado, motivoCierre: motivo, saldo };
    } },
];

const MENSAJE_FOLIO_CERRADO = "El folio ya está cerrado: no admite más movimientos.";
type ConceptoMock = "hospedaje" | "ab" | "extras" | "ajuste" | "propina" | "otro";
interface FolioMock {
  id: string;
  estado: "abierto" | "cerrado";
  reservationId: string;
  etiqueta: string;
  motivoCierre: "saldo_cero" | "cuenta_por_cobrar" | null;
  cerradoEn: string | null;
  cargos: { id: string; concepto: ConceptoMock; descripcion: string; monto: number; impuesto: number; revertidoPor: string | null; reversaDe: string | null; transferidoDe: string | null; creadoEn: string }[];
}
function folioMock(p: { estado: { obtener<T>(k: string, s: () => T): T } }): FolioMock {
  return p.estado.obtener<FolioMock>("hoteles.folio", () => ({ id: "fol-1", estado: "abierto", reservationId: "res-1", etiqueta: "Principal", motivoCierre: null, cerradoEn: null, cargos: [] }));
}
function saldoFolio(f: FolioMock): number {
  return Math.round(f.cargos.reduce((n, c) => n + c.monto + c.impuesto, 0) * 100) / 100;
}
function serializarFolio(f: FolioMock) {
  return { id: f.id, estado: f.estado, reservationId: f.reservationId, etiqueta: f.etiqueta, esPrincipal: true, cerradoEn: f.cerradoEn, motivoCierre: f.motivoCierre, cargos: f.cargos, pagos: [], saldo: saldoFolio(f) };
}

// H-P3-04/05/06 -- configuracion del hotel, equipo y Primeros pasos con ESTADO por escenario: un PUT/POST se refleja en el GET siguiente y en el
// checklist (que se calcula desde ese mismo estado, como el servidor real). Semilla: un hotel que ya opera con reservas y tiene todo lo obligatorio
// hecho (el humo del Resumen no cambia); solo falta el equipo y los canales. Solo existe en la API simulada de e2e.
const ROLES_ADMIN_HOTEL = ["owner", "admin"] as const;
const AVISO_ISH_MOCK = "La tasa del ISH depende del estado y del municipio: verifícala con tu contador antes de guardarla.";
interface ConfigHotelMock {
  impuestos: { ivaRate: number; ishRate: number; discountThreshold: number; dsaPerNight: number; configurado: boolean };
  politica: { freeUntilHours: number; penaltyPct: number; guestText: string | null; configurado: boolean };
  sobreventa: { roomTypeId: string; name: string; maxOverbookRooms: number; thresholdPct: number }[];
  tarifas: { id: string; roomTypeId: string; roomTypeName: string; date: string; price: number; currency: string; minStay: number; closedToArrival: boolean; closedToDeparture: boolean; manualPriceAt: string | null }[];
  bitacora: { id: string; area: string; entityId: string | null; actorUserId: string | null; valorAnterior: Record<string, unknown> | null; valorNuevo: Record<string, unknown>; createdAt: string }[];
  invitaciones: { id: string; email: string; verticalRole: string; propertyIds: null; status: string; expiresAt: string; createdAt: string }[];
  omitido: boolean;
}
const TIPO_MOCK = "00000000-0000-4000-8000-0000000000a1";
function configHotel(p: { estado: { obtener<T>(k: string, s: () => T): T } }): ConfigHotelMock {
  return p.estado.obtener<ConfigHotelMock>("hoteles.configuracion", () => ({
    impuestos: { ivaRate: 0.16, ishRate: 0.03, discountThreshold: 500, dsaPerNight: 0, configurado: true },
    politica: { freeUntilHours: 24, penaltyPct: 0.5, guestText: "Cancelación gratis hasta 24 horas antes.", configurado: true },
    sobreventa: [{ roomTypeId: TIPO_MOCK, name: "Doble vista al mar", maxOverbookRooms: 0, thresholdPct: 95 }],
    tarifas: [1, 2, 3].map((n) => ({ id: `00000000-0000-4000-8000-0000000001${n}0`, roomTypeId: TIPO_MOCK, roomTypeName: "Doble vista al mar", date: `2026-12-0${n}`, price: 1500 + n * 50, currency: "MXN", minStay: 1, closedToArrival: false, closedToDeparture: false, manualPriceAt: null })),
    bitacora: [],
    invitaciones: [],
    omitido: false,
  }));
}
function registrarCambio(c: ConfigHotelMock, area: string, anterior: Record<string, unknown> | null, nuevo: Record<string, unknown>): void {
  c.bitacora.unshift({ id: `bit-${c.bitacora.length + 1}`, area, entityId: null, actorUserId: "hoteles-owner", valorAnterior: anterior, valorNuevo: nuevo, createdAt: new Date().toISOString() });
}
function checklistMock(c: ConfigHotelMock) {
  const equipo = c.invitaciones.filter((i) => i.status === "pending").length;
  const items = [
    { id: "tipos_habitacion", titulo: "Tipos de habitación", estado: "hecho", obligatorio: true, detalle: "1 tipo(s) de habitación creados.", responsable: "dueno", pantalla: "catalogo" },
    { id: "habitaciones", titulo: "Habitaciones físicas", estado: "hecho", obligatorio: true, detalle: "12 habitación(es) registradas.", responsable: "dueno", pantalla: "catalogo" },
    { id: "tarifas", titulo: "Tarifas para los próximos 30 días", estado: "hecho", obligatorio: true, detalle: "Todos los tipos tienen tarifa para las próximas 30 noches.", responsable: "dueno", pantalla: "configuracion", pestana: "tarifas" },
    { id: "impuestos", titulo: "Impuestos revisados", estado: c.impuestos.configurado ? "hecho" : "pendiente", obligatorio: true, detalle: c.impuestos.configurado ? "IVA, ISH y umbral de descuento guardados por el hotel." : "Todavía no guardas tus impuestos.", responsable: "dueno", pantalla: "configuracion", pestana: "impuestos" },
    { id: "politica_cancelacion", titulo: "Política de cancelación", estado: c.politica.configurado ? "hecho" : "pendiente", obligatorio: true, detalle: "Horas libres, penalidad y texto para el huésped guardados.", responsable: "dueno", pantalla: "configuracion", pestana: "cancelacion" },
    { id: "whatsapp", titulo: "WhatsApp conectado", estado: "pendiente", obligatorio: false, detalle: "Sin número de WhatsApp: el agente no recibe mensajes de huéspedes. Requiere el número y las credenciales de Meta.", responsable: "meta", pantalla: "mensajeria" },
    { id: "equipo", titulo: "Al menos un miembro del equipo", estado: equipo > 0 ? "parcial" : "pendiente", obligatorio: false, detalle: equipo > 0 ? `${equipo} invitación(es) pendiente(s) de aceptar.` : "Solo tú tienes acceso: invita a recepción, housekeeping o contabilidad.", responsable: "dueno", pantalla: "equipo" },
    { id: "reserva_prueba", titulo: "Reserva de prueba", estado: "hecho", obligatorio: false, detalle: "8 reserva(s) registradas.", responsable: "dueno", pantalla: "reservas" },
  ];
  const hechos = items.filter((i) => i.estado === "hecho").length;
  const obligatoriosPendientes = items.filter((i) => i.obligatorio && i.estado !== "hecho").length;
  return { bloquea: false, obligatoriosPendientes, operaConReservas: true, listoParaOperar: obligatoriosPendientes === 0, nochesRequeridas: 30, resumen: { hechos, total: items.length, obligatoriosPendientes }, items };
}

export const rutasHotelesConfiguracion: readonly Ruta[] = [
  { metodo: "GET", patron: `${H}/primeros-pasos`, roles: ROLES_ADMIN_HOTEL, manejador: (p) => checklistMock(configHotel(p)) },
  { metodo: "POST", patron: `${H}/primeros-pasos/omitir`, roles: ROLES_ADMIN_HOTEL, manejador: (p) => {
      const c = configHotel(p);
      c.omitido = true;
      registrarCambio(c, "onboarding_omitido", null, { omitido: true });
      return { omitido: true, registrada: true };
    } },
  { metodo: "GET", patron: `${H}/configuracion/impuestos`, roles: ["owner", "admin", "finanzas"], manejador: (p) => ({ ...configHotel(p).impuestos, aviso: AVISO_ISH_MOCK }) },
  { metodo: "PUT", patron: `${H}/configuracion/impuestos`, roles: ROLES_ADMIN_HOTEL, manejador: (p) => {
      const c = configHotel(p);
      const b = (p.cuerpo ?? {}) as { ivaRate?: number; ishRate?: number; discountThreshold?: number; dsaPerNight?: number };
      const razon = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;
      if (!razon(b.ivaRate) || !razon(b.ishRate)) return fallo(400, "ivaRate debe ser un número entre 0 y 1 (ej. 0.16 para 16 %).");
      if (typeof b.discountThreshold !== "number" || b.discountThreshold < 0) return fallo(400, "discountThreshold debe ser un número mayor o igual a 0.");
      const antes = { ivaRate: c.impuestos.ivaRate, ishRate: c.impuestos.ishRate, discountThreshold: c.impuestos.discountThreshold, dsaPerNight: c.impuestos.dsaPerNight };
      c.impuestos = { ivaRate: b.ivaRate as number, ishRate: b.ishRate as number, discountThreshold: b.discountThreshold, dsaPerNight: b.dsaPerNight ?? 0, configurado: true };
      const despues = { ivaRate: c.impuestos.ivaRate, ishRate: c.impuestos.ishRate, discountThreshold: c.impuestos.discountThreshold, dsaPerNight: c.impuestos.dsaPerNight };
      if (JSON.stringify(antes) !== JSON.stringify(despues)) registrarCambio(c, "impuestos", antes, despues);
      return { ...c.impuestos, aviso: AVISO_ISH_MOCK };
    } },
  { metodo: "GET", patron: `${H}/configuracion/politica-cancelacion`, roles: ["owner", "admin", "finanzas"], manejador: (p) => configHotel(p).politica },
  { metodo: "PUT", patron: `${H}/configuracion/politica-cancelacion`, roles: ROLES_ADMIN_HOTEL, manejador: (p) => {
      const c = configHotel(p);
      const b = (p.cuerpo ?? {}) as { freeUntilHours?: number; penaltyPct?: number; guestText?: string | null };
      if (typeof b.freeUntilHours !== "number" || !Number.isInteger(b.freeUntilHours) || b.freeUntilHours < 0) return fallo(400, "freeUntilHours debe ser un entero de horas entre 0 y 8760.");
      if (typeof b.penaltyPct !== "number" || b.penaltyPct < 0 || b.penaltyPct > 1) return fallo(400, "penaltyPct debe ser un número entre 0 y 1 (ej. 0.16 para 16 %).");
      const antes = { freeUntilHours: c.politica.freeUntilHours, penaltyPct: c.politica.penaltyPct, guestText: c.politica.guestText };
      c.politica = { freeUntilHours: b.freeUntilHours, penaltyPct: b.penaltyPct, guestText: b.guestText ?? null, configurado: true };
      registrarCambio(c, "politica_cancelacion", antes, { freeUntilHours: c.politica.freeUntilHours, penaltyPct: c.politica.penaltyPct, guestText: c.politica.guestText });
      return c.politica;
    } },
  { metodo: "GET", patron: `${H}/configuracion/sobreventa`, roles: ["owner", "admin", "finanzas"], manejador: (p) => ({ tipos: configHotel(p).sobreventa }) },
  { metodo: "PUT", patron: `${H}/configuracion/sobreventa/:rt`, roles: ROLES_ADMIN_HOTEL, manejador: (p) => {
      const c = configHotel(p);
      const tipo = c.sobreventa.find((t) => t.roomTypeId === p.params.rt);
      if (!tipo) return fallo(404, "Tipo de habitación no encontrado en esta property.");
      const b = (p.cuerpo ?? {}) as { maxOverbookRooms?: number; thresholdPct?: number };
      if (typeof b.maxOverbookRooms !== "number" || !Number.isInteger(b.maxOverbookRooms) || b.maxOverbookRooms < 0 || b.maxOverbookRooms > 100) return fallo(400, "maxOverbookRooms debe ser un entero entre 0 y 100 (0 = sin sobreventa).");
      const antes = { maxOverbookRooms: tipo.maxOverbookRooms, thresholdPct: tipo.thresholdPct };
      tipo.maxOverbookRooms = b.maxOverbookRooms;
      if (typeof b.thresholdPct === "number") tipo.thresholdPct = b.thresholdPct;
      registrarCambio(c, "sobreventa", antes, { maxOverbookRooms: tipo.maxOverbookRooms, thresholdPct: tipo.thresholdPct });
      return tipo;
    } },
  { metodo: "GET", patron: `${H}/configuracion/bitacora`, roles: ROLES_ADMIN_HOTEL, manejador: (p) => ({ entradas: configHotel(p).bitacora }) },
  { metodo: "GET", patron: `${H}/tipos-habitacion`, manejador: () => [{ id: TIPO_MOCK, nombre: "Doble vista al mar", capacidadMaxima: 2 }] },
  { metodo: "GET", patron: `${H}/tarifas`, roles: ["owner", "admin", "finanzas"], manejador: (p) => ({ desde: p.query.get("desde") ?? "2026-12-01", hasta: p.query.get("hasta") ?? "2026-12-30", tarifas: configHotel(p).tarifas, truncado: false }) },
  { metodo: "PUT", patron: `${H}/tarifas/:tid`, roles: ROLES_ADMIN_HOTEL, manejador: (p) => {
      const c = configHotel(p);
      const t = c.tarifas.find((x) => x.id === p.params.tid);
      if (!t) return fallo(404, "Tarifa no encontrada en esta property.");
      const b = (p.cuerpo ?? {}) as { precio?: number; estanciaMinima?: number };
      if (typeof b.precio !== "number" || b.precio < 0) return fallo(400, "precio debe ser un número mayor o igual a 0.");
      const antes = { fecha: t.date, roomTypeId: t.roomTypeId, price: t.price, minStay: t.minStay };
      t.price = b.precio;
      if (typeof b.estanciaMinima === "number") t.minStay = b.estanciaMinima;
      t.manualPriceAt = new Date().toISOString();
      registrarCambio(c, "tarifa", antes, { fecha: t.date, roomTypeId: t.roomTypeId, price: t.price, minStay: t.minStay });
      return t;
    } },
  // Equipo (invitaciones reales del servidor: el token solo sale al crear).
  { metodo: "GET", patron: "/v1/hoteles/:id/admin/staff/invitaciones", roles: ROLES_ADMIN_HOTEL, manejador: (p) => ({ invitations: configHotel(p).invitaciones.filter((i) => i.status === "pending") }) },
  { metodo: "POST", patron: "/v1/hoteles/:id/admin/staff/invitaciones", roles: ROLES_ADMIN_HOTEL, manejador: (p) => {
      const c = configHotel(p);
      const b = (p.cuerpo ?? {}) as { email?: string; verticalRole?: string };
      if (typeof b.email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(b.email)) return fallo(400, "email inválido");
      if (!["owner", "gm", "frontdesk", "reservations", "housekeeping", "maintenance", "fnb", "accountant"].includes(String(b.verticalRole))) return fallo(400, "verticalRole inválido");
      const inv = { id: `inv-${c.invitaciones.length + 1}`, email: b.email.toLowerCase(), verticalRole: String(b.verticalRole), propertyIds: null, status: "pending", expiresAt: "2026-12-31T00:00:00.000Z", createdAt: new Date().toISOString() };
      c.invitaciones.push(inv);
      return conStatus(201, { ...inv, inviteToken: "token-de-ejemplo" });
    } },
  { metodo: "DELETE", patron: "/v1/hoteles/:id/admin/staff/invitaciones/:iid", roles: ROLES_ADMIN_HOTEL, manejador: (p) => {
      const inv = configHotel(p).invitaciones.find((i) => i.id === p.params.iid && i.status === "pending");
      if (!inv) return fallo(404, "Invitación no encontrada, ya fue usada, o ya estaba revocada.");
      inv.status = "revoked";
      return { ok: true };
    } },
  { metodo: "GET", patron: "/v1/hoteles/:id/admin/staff/miembros", roles: ROLES_ADMIN_HOTEL, manejador: () => ({ miembros: [{ id: "u-owner", email: "owner.hoteles@example.test", fullName: "Owner hoteles", verticalRole: "owner", propertyIds: null }] }) },
];

export const hoteles = { orgSlug: ORG.slug, propertyId: PROP.id };
