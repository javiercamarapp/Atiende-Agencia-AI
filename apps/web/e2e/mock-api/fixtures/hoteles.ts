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


// H-42 -- API PUBLICA de reserva directa del hotel (sin sesion): configuracion, disponibilidad, cotizacion, confirmar, estado y cancelar por token.
// Mismo formato que apps/api/src/routes/verticals/hoteles/reservar-publico.ts. Sin sesion caen en el escenario compartido "anon": el estado se aisla POR SLUG
// (cada prueba usa `${orgSlug}--<sufijo unico>`); la ultima habitacion se la queda quien confirme primero (la segunda confirmacion recibe 409 sin_disponibilidad),
// igual que el servidor. Cualquier otro slug responde 404 uniforme. Solo existe en la API simulada de e2e.
const TIPO_PUBLICO = "11111111-1111-4111-8111-111111111111";
const TOTAL_NOCHE = 118_000; // 100000 + IVA 16% + ISH 3%
interface ReservaPublicaMock {
  token: string;
  estado: "pago_pendiente" | "cancelada";
  llegada: string;
  salida: string;
  noches: number;
  huespedes: number;
  total: number;
}
const hotelPublico = (org: string): boolean => org === ORG.slug || org.startsWith(`${ORG.slug}--`);
const nochesEntre = (a: string, b: string): number => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
const vistaPublica = (r: ReservaPublicaMock) => ({
  estado: r.estado,
  hotel: PROP.nombre,
  tipoHabitacion: "Doble",
  llegada: r.llegada,
  salida: r.salida,
  noches: r.noches,
  huespedes: r.huespedes,
  totalCentavos: r.total,
  anticipoCentavos: Math.round(r.total * 0.3),
  pago: { estado: "pendiente", reembolso: null, ...(r.estado === "pago_pendiente" ? { requiereAccion: "El hotel te contactará para registrar tu anticipo." } : {}) },
  vigenteHasta: r.estado === "pago_pendiente" ? new Date(Date.now() + 60 * 60_000).toISOString() : null,
  cancelable: r.estado === "pago_pendiente",
  cancelacion: { gratisHasta: null, penalidadPct: 0, siCancelasAhora: null, resultado: r.estado === "cancelada" ? { penalidadCentavos: 0, reembolsoCentavos: 0 } : null },
});
const reservasPublicas = (p: { estado: { obtener<T>(k: string, s: () => T): T }; params: Readonly<Record<string, string>> }) => p.estado.obtener<ReservaPublicaMock[]>(`hoteles.reservar.reservas:${p.params["org"]}`, () => []);

const rutasHotelesPublicas: readonly Ruta[] = [
  {
    metodo: "GET",
    patron: "/v1/hoteles/:org/reservar",
    publica: true,
    manejador: (p) =>
      hotelPublico(p.params["org"]!)
        ? { disponible: true, hotel: { nombre: ORG.nombre }, propiedades: [{ slug: "casa-azul", nombre: PROP.nombre, reservaEnLinea: true, anticipoPct: 0.3, maxHuespedes: 4, maxNoches: 14, cancelacion: null }] }
        : fallo(404, "Hotel no encontrado."),
  },
  {
    metodo: "GET",
    patron: "/v1/hoteles/:org/reservar/disponibilidad",
    publica: true,
    manejador: (p) => {
      if (!hotelPublico(p.params["org"]!)) return fallo(404, "Hotel no encontrado.");
      const llegada = p.query.get("llegada") ?? "";
      const salida = p.query.get("salida") ?? "";
      const noches = nochesEntre(llegada, salida);
      if (!Number.isFinite(noches) || noches < 1) return fallo(400, "Las fechas de llegada y salida no son válidas.");
      const libre = reservasPublicas(p).filter((r) => r.estado !== "cancelada").length === 0;
      return { disponible: true, reservaEnLinea: true, propiedad: { slug: "casa-azul", nombre: PROP.nombre }, llegada, salida, noches, huespedes: Number(p.query.get("huespedes") ?? 1), anticipoPct: 0.3, opciones: [{ tipoHabitacionId: TIPO_PUBLICO, nombre: "Doble", maxOcupacion: 2, disponible: libre, motivo: libre ? null : "Sin disponibilidad", desdePorNocheCentavos: libre ? TOTAL_NOCHE : null, totalCentavos: libre ? TOTAL_NOCHE * noches : null }] };
    },
  },
  {
    metodo: "POST",
    patron: "/v1/hoteles/:org/reservar/cotizacion",
    publica: true,
    manejador: (p) => {
      if (!hotelPublico(p.params["org"]!)) return fallo(404, "Hotel no encontrado.");
      const c = (p.cuerpo ?? {}) as { llegada?: string; salida?: string; huespedes?: number; tipoHabitacionId?: string };
      if (!c.llegada || !c.salida || c.tipoHabitacionId !== TIPO_PUBLICO) return fallo(404, "No encontramos ese tipo de habitación.");
      const noches = nochesEntre(c.llegada, c.salida);
      const total = TOTAL_NOCHE * noches;
      if (reservasPublicas(p).some((r) => r.estado !== "cancelada")) return conStatus(409, { code: "sin_disponibilidad", message: "Ya no hay habitaciones disponibles de ese tipo para esas fechas." });
      const neto = 100_000 * noches;
      return { quoteToken: `q1.${Buffer.from(JSON.stringify({ c: c.llegada, s: c.salida, g: c.huespedes ?? 1, t: total })).toString("base64url")}.firma-mock-e2e`, venceEn: new Date(Date.now() + 15 * 60_000).toISOString(), propiedad: { slug: "casa-azul", nombre: PROP.nombre }, tipoHabitacion: { id: TIPO_PUBLICO, nombre: "Doble" }, llegada: c.llegada, salida: c.salida, noches, huespedes: c.huespedes ?? 1, cotizacion: { netoCentavos: neto, ivaCentavos: neto * 0.16, ishCentavos: neto * 0.03, totalCentavos: total }, anticipo: { porcentaje: 0.3, centavos: Math.round(total * 0.3), requerido: true }, cancelacion: { gratisHasta: null, penalidadPct: 0 } };
    },
  },
  {
    metodo: "POST",
    patron: "/v1/hoteles/:org/reservar/confirmar",
    publica: true,
    manejador: (p) => {
      if (!hotelPublico(p.params["org"]!)) return fallo(404, "Hotel no encontrado.");
      const c = (p.cuerpo ?? {}) as { quoteToken?: string; consentimientoAviso?: boolean; huesped?: { nombre?: string } };
      if (!p.cabeceras["idempotency-key"]) return fallo(400, "Idempotency-Key: obligatoria.");
      if (c.consentimientoAviso !== true) return fallo(400, "Debes aceptar el aviso de privacidad para reservar.");
      const partes = String(c.quoteToken ?? "").split(".");
      let q: { c: string; s: string; g: number; t: number };
      try {
        q = JSON.parse(Buffer.from(partes[1] ?? "", "base64url").toString("utf8"));
      } catch {
        return fallo(400, "La cotización no es válida. Vuelve a cotizar.");
      }
      const reservas = reservasPublicas(p);
      if (reservas.some((r) => r.estado !== "cancelada")) return conStatus(409, { code: "sin_disponibilidad", message: "Ya no hay habitaciones disponibles de ese tipo para esas fechas." });
      const r: ReservaPublicaMock = { token: `tok-${p.params["org"]}-${reservas.length + 1}`, estado: "pago_pendiente", llegada: q.c, salida: q.s, noches: nochesEntre(q.c, q.s), huespedes: q.g, total: q.t };
      reservas.push(r);
      return conStatus(202, { rastreoToken: r.token, ...vistaPublica(r) });
    },
  },
  {
    metodo: "GET",
    patron: "/v1/hoteles/:org/reservar/estado/:token",
    publica: true,
    manejador: (p) => {
      const r = hotelPublico(p.params["org"]!) ? reservasPublicas(p).find((x) => x.token === p.params["token"]) : undefined;
      return r ? vistaPublica(r) : fallo(404, "No encontramos esa reserva.");
    },
  },
  {
    metodo: "POST",
    patron: "/v1/hoteles/:org/reservar/estado/:token/cancelar",
    publica: true,
    manejador: (p) => {
      const r = hotelPublico(p.params["org"]!) ? reservasPublicas(p).find((x) => x.token === p.params["token"]) : undefined;
      if (!r) return fallo(404, "No encontramos esa reserva.");
      if (!p.cabeceras["idempotency-key"]) return fallo(400, "Idempotency-Key: obligatoria.");
      r.estado = "cancelada";
      return vistaPublica(r);
    },
  },
];

export const rutasHoteles: readonly Ruta[] = [
  ...rutasHotelesPublicas,
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
];

export const hoteles = { orgSlug: ORG.slug, propertyId: PROP.id };
