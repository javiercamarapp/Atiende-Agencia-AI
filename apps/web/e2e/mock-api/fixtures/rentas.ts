// Fixtures de rentas vacacionales (Rentas Sol y Mar). Forma = apps/web/src/verticals/rentas/lib/calendario-client.ts.
import { conStatus, fallo, ndjson } from "../respuestas.ts";
import { orgDe, propiedadDe } from "../personas.ts";
import type { Ruta } from "../tipos.ts";

const PROP = propiedadDe("rentas");
const ORG = orgDe("rentas");
const R = "/rentas/:id";

const UNIDADES = [
  { id: "uni-1", nombre: "Casa Playa Norte", duracionMinimaNoches: 2 },
  { id: "uni-2", nombre: "Depto Malecon 4B", duracionMinimaNoches: 1 },
];

// Rn-P3-20/21: mensajeria con huesped (bandeja de Aprobaciones y su hilo). Forma = lib/mensajeria-client.ts. Una conversacion con un
// mensaje que trae una emergencia (borrador ESCALADO, pendiente) y otro rutinario ya respondido; el estado se guarda por escenario para
// que rechazar o generar se refleje en el GET siguiente. Solo existe en la API simulada de e2e.
interface BorradorMock {
  id: string;
  conversacionId: string;
  mensajeEntranteId: string | null;
  canal: string;
  texto: string;
  estado: string;
  generadoPor: string;
  redactado: boolean;
  necesitaEscalamiento: boolean;
  senales: string[];
  aprobadoPor: string | null;
  aprobadoEn: string | null;
  rechazadoPor: string | null;
  rechazadoEn: string | null;
  motivoRechazo: string | null;
  mensajeEnviadoId: string | null;
  creadoEn: string;
  actualizadoEn: string;
}
const CONV_ZAPATA = { id: "conv-1", organizationId: ORG.id, propertyId: PROP.id, unidadId: "uni-1", canal: "airbnb", ocupacionId: "ocu-1", huespedMinimoId: null, propiedadNombre: "Casa Playa Norte", huespedNombre: "Familia Zapata", fechaCheckIn: null, fechaCheckOut: null, reservaConfirmada: true, creadoEn: "2026-10-01T09:00:00.000Z" };
const MENSAJES_ZAPATA = [
  { id: "msg-1", conversacionId: "conv-1", direccion: "entrante", origen: "manual", texto: "Hola, ¿cuál es la clave del wifi?", redactado: false, creadoEn: "2026-10-01T10:00:00.000Z" },
  { id: "msg-2", conversacionId: "conv-1", direccion: "saliente", origen: "simulador", texto: "Hola, la clave es la que aparece en la guía de la casa.", redactado: false, creadoEn: "2026-10-01T10:05:00.000Z" },
  { id: "msg-3", conversacionId: "conv-1", direccion: "entrante", origen: "manual", texto: "Es una emergencia: huele a gas en la cocina", redactado: false, creadoEn: "2026-10-02T08:00:00.000Z" },
];
function borradoresSemilla(): BorradorMock[] {
  const base = { conversacionId: "conv-1", canal: "airbnb", generadoPor: "motor_borrador", redactado: false, aprobadoPor: null, aprobadoEn: null, rechazadoPor: null, rechazadoEn: null, motivoRechazo: null, mensajeEnviadoId: null, actualizadoEn: "2026-10-02T08:01:00.000Z" };
  return [
    { ...base, id: "bor-1", mensajeEntranteId: "msg-1", texto: "Hola, la clave es la que aparece en la guía de la casa.", estado: "enviado", necesitaEscalamiento: false, senales: [], creadoEn: "2026-10-01T10:02:00.000Z", aprobadoPor: "00000000-0000-4000-8000-000000000001", aprobadoEn: "2026-10-01T10:05:00.000Z", mensajeEnviadoId: "msg-2" },
    { ...base, id: "bor-2", mensajeEntranteId: "msg-3", texto: "Lamentamos lo ocurrido. Por favor sal de la casa y llama al 911; avisamos al equipo de inmediato.", estado: "pendiente_aprobacion", necesitaEscalamiento: true, senales: ["emergencia"], creadoEn: "2026-10-02T08:01:00.000Z" },
  ];
}
const borradoresMock = (p: { estado: { obtener<T>(k: string, s: () => T): T } }) => p.estado.obtener<BorradorMock[]>("rentas.mensajeria.borradores", borradoresSemilla);

function dia(desdeHoy: number): string {
  return new Date(Date.now() + desdeHoy * 86_400_000).toISOString().slice(0, 10);
}

interface Ocupacion {
  id: string;
  unidadId: string;
  capa: "reserva" | "bloqueo";
  rango: { inicio: string; fin: string };
  razon: string;
  estado: string;
  canalCodigo: string | null;
  huespedNombre: string | null;
  huespedContacto: string | null;
  createdAt: string;
}

function ocupacionesSemilla(): Ocupacion[] {
  return [
    { id: "ocu-1", unidadId: "uni-1", capa: "reserva", rango: { inicio: dia(4), fin: dia(7) }, razon: "RESERVA_CANAL", estado: "confirmado", canalCodigo: null, huespedNombre: "Familia Zapata", huespedContacto: "+529995550401", createdAt: "2026-09-28T15:00:00.000Z" },
    { id: "ocu-2", unidadId: "uni-1", capa: "bloqueo", rango: { inicio: dia(12), fin: dia(14) }, razon: "MANTENIMIENTO", estado: "confirmado", canalCodigo: null, huespedNombre: null, huespedContacto: null, createdAt: "2026-09-29T15:00:00.000Z" },
  ];
}

// CHAT-10 -- Copiloto ("Pregunta a tus datos") de rentas: respuesta fija en el formato REAL del servidor (NDJSON paso/fin con
// conversacionId y seq; conversaciones guardadas por escenario). Solo admin_gestora ("admin") y contador ("finanzas") entran: el resto
// recibe 403 como en la API real. Solo existe en la API simulada de e2e.
interface ConversacionMock {
  id: string;
  titulo: string;
  actualizadaEn: string;
  mensajes: { id: string; role: "user" | "assistant"; text: string; status?: string; blocks?: unknown[]; sources?: unknown[]; seq: number }[];
}
const MOCK_ROLES_COPILOTO = ["admin", "finanzas"] as const;
const BLOQUE_INGRESOS = {
  kind: "table",
  tool: "ingresos_por_canal",
  title: "Ingresos por canal",
  columns: [
    { key: "canal", label: "Canal", kind: "text" },
    { key: "reservas", label: "Reservas", kind: "integer" },
    { key: "bruto", label: "Ingreso bruto", kind: "mxn" },
  ],
  rows: [
    { canal: "Airbnb", reservas: 9, bruto: 31200 },
    { canal: "Booking", reservas: 4, bruto: 12800 },
    { canal: "Directa", reservas: 3, bruto: 9400 },
  ],
  chart: { kind: "bar", x: "canal", y: "bruto" },
  truncated: false,
};
const TEXTO_INGRESOS = "Este mes ingresaste $53,400 MXN brutos en 16 reservas, la mayoría por Airbnb.";
const FUENTE_INGRESOS = { tool: "ingresos_por_canal", source: "Reservas con llegada en el periodo", periodLabel: "este mes", scopeLabel: "todas tus propiedades" };
const conversacionesMock = (p: { estado: { obtener<T>(k: string, s: () => T): T } }) => p.estado.obtener<ConversacionMock[]>("rentas.copiloto.conversaciones", () => []);

export const rutasRentas: readonly Ruta[] = [
  { metodo: "GET", patron: `${R}/chat-datos/pins`, roles: MOCK_ROLES_COPILOTO, manejador: () => ({ disponible: true, pins: [] }) },
  { metodo: "GET", patron: `${R}/chat-datos/estado`, roles: MOCK_ROLES_COPILOTO, manejador: () => ({ available: true, permitido: true, motivo: null, usoHoyPct: 0 }) },
  {
    metodo: "POST",
    patron: `${R}/chat-datos`,
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
      conv.mensajes.push({ id: `m-${seq}`, role: "assistant", text: TEXTO_INGRESOS, status: "ok", blocks: [BLOQUE_INGRESOS], sources: [FUENTE_INGRESOS], seq });
      conv.actualizadaEn = new Date().toISOString();
      return ndjson([
        { t: "paso", fase: "inicio", herramienta: "ingresos_por_canal" },
        { t: "paso", fase: "fin", herramienta: "ingresos_por_canal" },
        { t: "fin", conversacionId: conv.id, seq, respuesta: { status: "ok", text: TEXTO_INGRESOS, blocks: [BLOQUE_INGRESOS], sources: [FUENTE_INGRESOS], toolsUsed: ["ingresos_por_canal"] } },
      ]);
    },
  },
  { metodo: "GET", patron: `${R}/chat-datos/conversaciones`, roles: MOCK_ROLES_COPILOTO, manejador: (p) => ({ disponible: true, conversaciones: conversacionesMock(p).map((c) => ({ id: c.id, titulo: c.titulo, actualizadaEn: c.actualizadaEn, mensajes: c.mensajes.length })) }) },
  { metodo: "GET", patron: `${R}/chat-datos/conversaciones/:cid`, roles: MOCK_ROLES_COPILOTO, manejador: (p) => conversacionesMock(p).find((c) => c.id === p.params["cid"]) ?? fallo(404, "Conversación no encontrada.") },
  {
    metodo: "PATCH",
    patron: `${R}/chat-datos/conversaciones/:cid`,
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
    patron: `${R}/chat-datos/conversaciones/:cid`,
    roles: MOCK_ROLES_COPILOTO,
    manejador: (p) => {
      const lista = conversacionesMock(p);
      const i = lista.findIndex((x) => x.id === p.params["cid"]);
      if (i < 0) return fallo(404, "Conversación no encontrada.");
      lista.splice(i, 1);
      return conStatus(204, undefined);
    },
  },
  { metodo: "GET", patron: "/v1/rentas/:org/admin/propiedades", manejador: () => ({ propiedades: [{ propertyId: PROP.id, nombre: PROP.nombre }] }) },
  { metodo: "GET", patron: `${R}/unidades`, manejador: () => ({ unidades: UNIDADES }) },
  { metodo: "GET", patron: `${R}/unidades/:uid/ocupaciones`, manejador: (p) => ({ ocupaciones: p.estado.obtener("rentas.ocupaciones", ocupacionesSemilla).filter((o) => o.unidadId === p.params.uid) }) },
  { metodo: "GET", patron: `${R}/calendario`, manejador: (p) => ({
      zona_horaria: "America/Merida",
      hoy: dia(0),
      total: 2,
      truncado: false,
      ocupaciones: p.estado.obtener("rentas.ocupaciones", ocupacionesSemilla).map(({ huespedContacto: _c, createdAt: _t, ...visual }) => visual),
    }) },
  // Rn-26: el Resumen operativo se deriva del MISMO estado de ocupaciones que sirve el calendario (cancelar una reserva en el
  // humo cambia las cifras), para que el mock no pueda contradecirse con las pantallas de origen.
  { metodo: "GET", patron: `${R}/resumen`, manejador: (p) => {
      const reservas = p.estado.obtener("rentas.ocupaciones", ocupacionesSemilla).filter((o) => o.capa === "reserva" && o.estado === "confirmado");
      const hoy = dia(0);
      const ahora = new Date();
      const inicioMes = new Date(Date.UTC(ahora.getUTCFullYear(), ahora.getUTCMonth(), 1)).toISOString().slice(0, 10);
      const inicioSiguiente = new Date(Date.UTC(ahora.getUTCFullYear(), ahora.getUTCMonth() + 1, 1)).toISOString().slice(0, 10);
      const nochesMes = Math.round((Date.parse(inicioSiguiente) - Date.parse(inicioMes)) / 86_400_000);
      const noches = reservas.reduce((acc, o) => {
        const ini = Math.max(Date.parse(o.rango.inicio), Date.parse(inicioMes));
        const fin = Math.min(Date.parse(o.rango.fin), Date.parse(inicioSiguiente));
        return acc + Math.max(0, Math.round((fin - ini) / 86_400_000));
      }, 0);
      const disponibles = nochesMes * UNIDADES.length;
      return {
        ahora: ahora.toISOString(),
        zona_horaria: "America/Merida",
        hoy,
        llegadas_salidas: { estado: "ok", llegadas: reservas.filter((o) => o.rango.inicio === hoy).length, salidas: reservas.filter((o) => o.rango.fin === hoy).length },
        ocupacion_mes: { estado: "ok", periodo: { desde: inicioMes, hasta: inicioSiguiente }, ocupacion_basis_points: Math.round((noches / disponibles) * 10000), noches_ocupadas: noches, noches_disponibles: disponibles, unidades: UNIDADES.length },
        conflictos: { estado: "ok", abiertos: 0 },
        limpieza: { estado: "ok", pendientes: 0, vencidas: 0 },
        aprobaciones: { estado: "ok", pendientes: 0 },
        feeds: { estado: "ok", activos: 0, con_problema: 0 },
        agentes: [],
      };
    } },
  // Rn-P3-20/21/22: bandeja de aprobacion e hilo de una conversacion.
  { metodo: "GET", patron: `${R}/unidades/:uid/conversaciones`, manejador: (p) => ({ conversaciones: p.params.uid === "uni-1" ? [CONV_ZAPATA] : [] }) },
  { metodo: "GET", patron: `${R}/conversaciones/:cid/borradores`, manejador: (p) => ({ borradores: borradoresMock(p).filter((b) => b.conversacionId === p.params.cid) }) },
  { metodo: "GET", patron: `${R}/conversaciones/:cid/hilo`, manejador: (p) => (p.params.cid === CONV_ZAPATA.id ? { conversacion: CONV_ZAPATA, mensajes: MENSAJES_ZAPATA, borradores: borradoresMock(p).filter((b) => b.conversacionId === CONV_ZAPATA.id) } : fallo(404, "Conversación no encontrada en esta property.")) },
  { metodo: "GET", patron: `${R}/mensajeria/politicas`, manejador: () => ({ politicas: [{ canal: "airbnb", maxCaracteres: 4000, permiteContactoDirectoPreReserva: false, permiteAutomatizacionPreReserva: true, accionAntePreReservaProhibida: "bloquear" }] }) },
  { metodo: "POST", patron: `${R}/borradores/:bid/rechazar`, manejador: (p) => {
      const b = borradoresMock(p).find((x) => x.id === p.params.bid);
      if (!b) return fallo(404, "Borrador no encontrado en esta property.");
      const motivo = (p.cuerpo as { motivo?: string } | null)?.motivo ?? "";
      Object.assign(b, { estado: "rechazado", rechazadoPor: "00000000-0000-4000-8000-000000000001", rechazadoEn: new Date().toISOString(), motivoRechazo: motivo });
      return b;
    } },
  { metodo: "POST", patron: `${R}/unidades/:uid/reservas/:oid/cancelar`, manejador: (p) => cancelar(p.estado.obtener("rentas.ocupaciones", ocupacionesSemilla), p.params.oid) },
  { metodo: "POST", patron: `${R}/unidades/:uid/bloqueos/:oid/cancelar`, manejador: (p) => cancelar(p.estado.obtener("rentas.ocupaciones", ocupacionesSemilla), p.params.oid) },
];

function cancelar(lista: Ocupacion[], id: string | undefined) {
  const o = lista.find((x) => x.id === id);
  if (!o) return fallo(404, "Esa ocupacion no existe");
  o.estado = "cancelado";
  return o;
}

export const rentas = { orgSlug: ORG.slug, propertyId: PROP.id };
