// QA R1 (botones y paginas) de citas: rutas con ESTADO del panel de citas que el humo no necesitaba. Van ANTES de `rutasCitas`
// en el indice, asi que sustituyen a las rutas fijas equivalentes de citas.ts (sucursales, agenda, cancelar, lista de espera).
// Misma forma de cable que apps/web/src/verticals/citas/lib/*-client.ts (snake_case) y mismos codigos que el servidor real
// (apps/api/src/routes/verticals/citas/*.ts: 409 por estado/choque, 400 por validacion, 404 por id ajeno). Solo existe en la API
// simulada de e2e: nada sale a WhatsApp, Google, Cal.com ni CalDAV reales.
//
// Estado por escenario y POR SUCURSAL (`<clave>:<propertyId>`), para poder comprobar que cambiar de sucursal no arrastra datos de
// la otra. Una prueba siembra una segunda sucursal con `mock.agregarAEstado("citas.branches", {...})` (la lista existe en cuanto
// el shell la pidio) y recarga la pagina.
import { conStatus, fallo } from "../respuestas.ts";
import { orgDe, propiedadDe } from "../personas.ts";
import type { Peticion, Ruta } from "../tipos.ts";

const PROP = propiedadDe("citas");
const ORG = orgDe("citas");
const P = "/v1/citas/properties/:id";
/** Segunda sucursal que las pruebas pueden sembrar (UUID sintetico, contenido obviamente falso). */
export const SUCURSAL_NORTE = { propertyId: "00000000-0000-4000-8000-0000000000c2", name: "Consultorio Norte" } as const;

type Est = Peticion["estado"];
const clave = (base: string, p: Peticion) => `${base}:${p.params["id"] ?? PROP.id}`;
const esNorte = (p: Peticion) => p.params["id"] === SUCURSAL_NORTE.propertyId;
const hora = 3_600_000;

// ---------------------------------------------------------------- catalogo por sucursal
interface Proveedor {
  id: string;
  property_id: string;
  display_name: string;
  role_label: string;
  is_active: boolean;
}
interface Servicio {
  id: string;
  name: string;
  duration_minutes: number;
  buffer_minutes_before: number;
  buffer_minutes_after: number;
  price_cents: number | null;
  is_active: boolean;
}
interface Cliente {
  id: string;
  full_name: string;
  phone: string;
  email: string | null;
}
function proveedoresSemilla(p: Peticion): Proveedor[] {
  if (esNorte(p)) return [{ id: "prv-n1", property_id: SUCURSAL_NORTE.propertyId, display_name: "Dra. Norma Uc", role_label: "Endodoncista", is_active: true }];
  return [
    { id: "prv-1", property_id: PROP.id, display_name: "Dra. Paola Medina", role_label: "Odontologa", is_active: true },
    { id: "prv-2", property_id: PROP.id, display_name: "Dr. Luis Cetina", role_label: "Ortodoncista", is_active: true },
  ];
}
function serviciosSemilla(p: Peticion): Servicio[] {
  if (esNorte(p)) return [{ id: "srv-n1", name: "Endodoncia", duration_minutes: 60, buffer_minutes_before: 0, buffer_minutes_after: 15, price_cents: 250000, is_active: true }];
  return [
    { id: "srv-1", name: "Limpieza dental", duration_minutes: 45, buffer_minutes_before: 0, buffer_minutes_after: 10, price_cents: 65000, is_active: true },
    { id: "srv-2", name: "Revision de ortodoncia", duration_minutes: 30, buffer_minutes_before: 0, buffer_minutes_after: 0, price_cents: 90000, is_active: true },
  ];
}
function clientesSemilla(p: Peticion): Cliente[] {
  if (esNorte(p)) return [{ id: "cli-n1", full_name: "Rosa Canul", phone: "+529995550301", email: null }];
  const base: Cliente[] = [
    { id: "cli-1", full_name: "Ana Lilia Pech", phone: "+529995550201", email: "ana.pech@example.test" },
    { id: "cli-2", full_name: "Mario Chan", phone: "+529995550202", email: null },
  ];
  // 23 clientes mas para que la paginacion (20 por pagina) tenga una segunda pagina real.
  for (let i = 3; i <= 25; i++) base.push({ id: `cli-${i}`, full_name: `Paciente Prueba ${String(i).padStart(2, "0")}`, phone: `+5299955502${String(i).padStart(2, "0")}`, email: null });
  return base;
}
const proveedores = (p: Peticion) => p.estado.obtener<Proveedor[]>(clave("citas.qa.proveedores", p), () => proveedoresSemilla(p));
const servicios = (p: Peticion) => p.estado.obtener<Servicio[]>(clave("citas.qa.servicios", p), () => serviciosSemilla(p));
const clientes = (p: Peticion) => p.estado.obtener<Cliente[]>(clave("citas.qa.clientes", p), () => clientesSemilla(p));

// ---------------------------------------------------------------- citas
interface Cita {
  id: string;
  property_id: string;
  provider_id: string;
  service_id: string;
  customer_id: string;
  starts_at: string;
  ends_at: string;
  status: string;
  source: string;
  notes: string | null;
  google_sync_status?: string;
  google_sync_error?: string | null;
  provider_name: string;
  service_name: string;
  customer_name: string;
  customer_phone: string;
}
function citasSemilla(p: Peticion): Cita[] {
  const ahora = Date.now();
  const prv = proveedores(p);
  const srv = servicios(p);
  const cli = clientes(p);
  const mk = (id: string, delta: number, status: string, i: number, j: number, k: number): Cita => ({
    id,
    property_id: p.params["id"] ?? PROP.id,
    provider_id: prv[i]!.id,
    service_id: srv[j]!.id,
    customer_id: cli[k]!.id,
    starts_at: new Date(ahora + delta * hora).toISOString(),
    ends_at: new Date(ahora + delta * hora + 45 * 60_000).toISOString(),
    status,
    source: "whatsapp",
    notes: null,
    provider_name: prv[i]!.display_name,
    service_name: srv[j]!.name,
    customer_name: cli[k]!.full_name,
    customer_phone: cli[k]!.phone,
  });
  // Mismas dos citas que la semilla de citas.ts (humo-citas cancela apt-1) para la sucursal principal.
  if (esNorte(p)) return [mk("apt-n1", 2, "confirmed", 0, 0, 0)];
  return [mk("apt-1", 1, "confirmed", 0, 0, 0), mk("apt-2", 3, "pending", 1, 1, 1)];
}
export const CLAVE_CITAS = (propertyId: string = PROP.id) => `citas.qa.citas:${propertyId}`;
const citas = (p: Peticion) => p.estado.obtener<Cita[]>(clave("citas.qa.citas", p), () => citasSemilla(p));
/** Banderas del escenario (lista): "rango" hace que el GET de citas filtre por from/to como el servidor real. */
const banderas = (e: Est) => e.obtener<string[]>("citas.qa.banderas", () => []);
const VIVAS = new Set(["pending", "confirmed"]);

function transicion(p: Peticion, permitidos: readonly string[], siguiente: string): unknown {
  const cita = citas(p).find((c) => c.id === p.params["aptId"]);
  if (!cita) return fallo(404, "Esa cita no existe");
  if (!permitidos.includes(cita.status)) return fallo(409, `La cita esta en estado "${cita.status}" y no admite este cambio.`);
  cita.status = siguiente;
  return { appointment: cita };
}

// ---------------------------------------------------------------- lista de espera
interface Candidato {
  id: string;
  position: number;
  customer_name: string;
  customer_phone: string;
  provider_id: string | null;
  service_id: string | null;
  preferred_date_from: string | null;
  preferred_date_to: string | null;
  preferred_time_window: string | null;
  notified_count: number;
  created_at: string;
}
function esperaSemilla(p: Peticion): Candidato[] {
  if (esNorte(p)) return [];
  const creado = new Date(Date.now() - 2 * 86_400_000).toISOString();
  return [
    { id: "wl-1", position: 1, customer_name: "Lucia Pool", customer_phone: "***0211", provider_id: null, service_id: "srv-1", preferred_date_from: null, preferred_date_to: null, preferred_time_window: "mananas", notified_count: 0, created_at: creado },
    { id: "wl-2", position: 2, customer_name: "Jorge Ek", customer_phone: "***0212", provider_id: "prv-2", service_id: "srv-2", preferred_date_from: null, preferred_date_to: null, preferred_time_window: null, notified_count: 1, created_at: creado },
  ];
}
const espera = (p: Peticion) => p.estado.obtener<Candidato[]>(clave("citas.qa.espera", p), () => esperaSemilla(p));
function filtrarEspera(p: Peticion, prv: string | null, srv: string | null): Candidato[] {
  return espera(p).filter((c) => (!prv || c.provider_id === null || c.provider_id === prv) && (!srv || c.service_id === null || c.service_id === srv));
}

// ---------------------------------------------------------------- rutas
export const rutasCitasQa: readonly Ruta[] = [
  {
    metodo: "GET",
    patron: "/v1/citas/:org/admin/branches",
    manejador: (p) => ({ branches: p.estado.obtener("citas.branches", () => [{ propertyId: PROP.id, name: PROP.nombre }]) }),
  },
  {
    metodo: "GET",
    patron: `${P}/appointments`,
    manejador: (p) => {
      let lista = citas(p);
      const prv = p.query.get("provider_id");
      if (prv) lista = lista.filter((c) => c.provider_id === prv);
      if (banderas(p.estado).includes("rango")) {
        const desde = p.query.get("from");
        const hasta = p.query.get("to");
        lista = lista.filter((c) => (!desde || c.starts_at >= new Date(desde).toISOString()) && (!hasta || c.starts_at < new Date(hasta).toISOString()));
      }
      return { appointments: [...lista].sort((a, b) => a.starts_at.localeCompare(b.starts_at)) };
    },
  },
  {
    metodo: "POST",
    patron: `${P}/appointments`,
    manejador: (p) => {
      const c = (p.cuerpo ?? {}) as { provider_id?: string; service_id?: string; customer_name?: string; customer_phone?: string; customer_email?: string; starts_at?: string; notes?: string };
      if (!c.provider_id || !c.service_id || !c.customer_name || !c.customer_phone || !c.starts_at) return fallo(400, "Faltan datos de la cita.");
      const prv = proveedores(p).find((x) => x.id === c.provider_id);
      const srv = servicios(p).find((x) => x.id === c.service_id);
      if (!prv || !srv) return fallo(404, "Proveedor o servicio inexistente en esta sucursal.");
      const ini = new Date(c.starts_at);
      if (Number.isNaN(ini.getTime())) return fallo(400, "starts_at invalido");
      const fin = new Date(ini.getTime() + srv.duration_minutes * 60_000);
      const choca = citas(p).find((x) => x.provider_id === prv.id && VIVAS.has(x.status) && new Date(x.starts_at) < fin && new Date(x.ends_at) > ini);
      if (choca) {
        const alt = new Date(new Date(choca.ends_at).getTime() + 15 * 60_000);
        return conStatus(409, { error: "Ese horario ya no esta disponible para este proveedor.", alternative_slots: [{ starts_at: alt.toISOString(), ends_at: new Date(alt.getTime() + srv.duration_minutes * 60_000).toISOString() }] });
      }
      let cli = clientes(p).find((x) => x.phone === c.customer_phone);
      if (!cli) {
        cli = { id: `cli-nuevo-${clientes(p).length + 1}`, full_name: c.customer_name, phone: c.customer_phone, email: c.customer_email ?? null };
        clientes(p).push(cli);
      }
      const cita: Cita = {
        id: `apt-manual-${citas(p).length + 1}`,
        property_id: p.params["id"]!,
        provider_id: prv.id,
        service_id: srv.id,
        customer_id: cli.id,
        starts_at: ini.toISOString(),
        ends_at: fin.toISOString(),
        status: "confirmed",
        source: "manual",
        notes: c.notes ?? null,
        provider_name: prv.display_name,
        service_name: srv.name,
        customer_name: cli.full_name,
        customer_phone: cli.phone,
      };
      citas(p).push(cita);
      return conStatus(201, { appointment: cita });
    },
  },
  { metodo: "POST", patron: `${P}/appointments/:aptId/cancel`, manejador: (p) => transicion(p, ["pending", "confirmed"], "cancelled") },
  { metodo: "POST", patron: `${P}/appointments/:aptId/confirm`, manejador: (p) => transicion(p, ["pending"], "confirmed") },
  { metodo: "POST", patron: `${P}/appointments/:aptId/complete`, manejador: (p) => transicion(p, ["pending", "confirmed"], "completed") },
  { metodo: "POST", patron: `${P}/appointments/:aptId/no-show`, manejador: (p) => transicion(p, ["pending", "confirmed"], "no_show") },
  {
    metodo: "POST",
    patron: `${P}/appointments/:aptId/retry-sync`,
    manejador: (p) => {
      const cita = citas(p).find((c) => c.id === p.params["aptId"]);
      if (!cita) return fallo(404, "Esa cita no existe");
      if (cita.google_sync_status !== "invalid") return fallo(409, "Esta cita no tiene una sincronizacion por reintentar.");
      cita.google_sync_status = "pending";
      cita.google_sync_error = null;
      return { appointment: cita };
    },
  },
  {
    metodo: "GET",
    patron: `${P}/waitlist`,
    manejador: (p) => ({ waitlist: filtrarEspera(p, p.query.get("provider_id"), p.query.get("service_id")) }),
  },
  {
    metodo: "POST",
    patron: `${P}/waitlist/broadcast`,
    manejador: (p) => {
      const c = (p.cuerpo ?? {}) as { provider_id?: string; service_id?: string };
      const lista = filtrarEspera(p, c.provider_id ?? null, c.service_id ?? null);
      for (const x of lista) x.notified_count += 1;
      return { queued: true, candidates_considered: lista.length, skipped_no_whatsapp_config: false };
    },
  },
  { metodo: "GET", patron: `${P}/providers`, manejador: (p) => ({ providers: proveedores(p) }) },
  { metodo: "GET", patron: `${P}/services`, manejador: (p) => ({ services: servicios(p) }) },
];


// ---------------------------------------------------------------- catalogo, clientes y disponibilidad (paginas de Negocio)
interface Regla {
  id: string;
  day_of_week: number;
  start_time: string;
  end_time: string;
  is_active: boolean;
}
interface Excepcion {
  override_date: string;
  is_closed: boolean;
  start_time: string | null;
  end_time: string | null;
  reason: string | null;
}
interface Calendarios {
  google: { connected: boolean; sync_status: "disconnected" | "connected" | "error"; sync_error: string | null };
  calcom: { connected: boolean; sync_status: "disconnected" | "connected" | "error"; sync_error: string | null; calcom_event_type_id: string | null; calcom_base_url: string | null };
  caldav: { connected: boolean; sync_status: "disconnected" | "connected" | "error"; sync_error: string | null; calendar_collection_url: string | null; username: string | null };
  ofrecidos: string[];
}
const reglas = (p: Peticion, prv: string) =>
  p.estado.obtener<Regla[]>(`citas.qa.reglas:${prv}`, () =>
    prv === "prv-1"
      ? [1, 2, 3, 4, 5].map((d) => ({ id: `rg-${prv}-${d}`, day_of_week: d, start_time: "09:00:00", end_time: "18:00:00", is_active: true }))
      : [{ id: `rg-${prv}-6`, day_of_week: 6, start_time: "10:00:00", end_time: "14:00:00", is_active: true }],
  );
const excepciones = (p: Peticion, prv: string) =>
  p.estado.obtener<Excepcion[]>(`citas.qa.excepciones:${prv}`, () => (prv === "prv-1" ? [{ override_date: "2026-12-25", is_closed: true, start_time: null, end_time: null, reason: "Navidad" }] : []));
const calendarios = (p: Peticion, prv: string) =>
  p.estado.obtener<Calendarios>(`citas.qa.calendarios:${prv}`, () => ({
    google: prv === "prv-2" ? { connected: true, sync_status: "connected", sync_error: null } : { connected: false, sync_status: "disconnected", sync_error: null },
    calcom: prv === "prv-2" ? { connected: true, sync_status: "connected", sync_error: null, calcom_event_type_id: "4455", calcom_base_url: null } : { connected: false, sync_status: "disconnected", sync_error: null, calcom_event_type_id: null, calcom_base_url: null },
    caldav: { connected: false, sync_status: "disconnected", sync_error: null, calendar_collection_url: null, username: null },
    ofrecidos: servicios(p).map((x) => x.id),
  }));
function proveedorDe(p: Peticion): Proveedor | undefined {
  return proveedores(p).find((x) => x.id === p.params["prvId"]);
}
const sinProveedor = () => fallo(404, "Proveedor no encontrado.");
const HHMM = /^\d{2}:\d{2}(:\d{2})?$/;

// ---------------------------------------------------------------- administracion
interface Invitacion {
  id: string;
  email: string;
  vertical_role: string;
  property_ids: string[] | null;
  status: string;
  expires_at: string;
  created_at: string;
}
interface Miembro {
  id: string;
  email: string;
  full_name: string;
  vertical_role: string;
  property_ids: string[] | null;
}
const invitaciones = (p: Peticion) =>
  p.estado.obtener<Invitacion[]>(clave("citas.qa.invitaciones", p), () => [
    { id: "inv-1", email: "recepcion@example.test", vertical_role: "staff", property_ids: null, status: "pending", expires_at: new Date(Date.now() + 5 * 86_400_000).toISOString(), created_at: new Date(Date.now() - 86_400_000).toISOString() },
  ]);
const miembros = (p: Peticion) =>
  p.estado.obtener<Miembro[]>(clave("citas.qa.miembros", p), () => [
    { id: p.persona?.id ?? "yo", email: p.persona?.email ?? "owner@example.test", full_name: p.persona?.fullName ?? "Owner", vertical_role: p.persona?.rol ?? "owner", property_ids: null },
    { id: "usr-asistente", email: "asistente@example.test", full_name: "Asistente Dental", vertical_role: "staff", property_ids: null },
  ]);
const RANGO_ROL: Readonly<Record<string, number>> = { staff: 1, admin: 2, owner: 3 };

interface SolicitudArco {
  id: string;
  folio: string;
  telefono: string;
  derecho: string;
  estado: string;
  plazo: string | null;
  solicitadaEn: string;
  respuestaVenceEn: string | null;
  ejecucionVenceEn: string | null;
  notaResolucion: string | null;
}
const solicitudes = (p: Peticion) =>
  p.estado.obtener<SolicitudArco[]>(clave("citas.qa.arco", p), () => [
    { id: "arco-1", folio: "ARCO-0001", telefono: "***0201", derecho: "acceso", estado: "recibida", plazo: "en_plazo", solicitadaEn: new Date(Date.now() - 3 * 86_400_000).toISOString(), respuestaVenceEn: new Date(Date.now() + 17 * 86_400_000).toISOString(), ejecucionVenceEn: null, notaResolucion: null },
    { id: "arco-2", folio: "ARCO-0002", telefono: "***0202", derecho: "cancelacion", estado: "en_proceso", plazo: "por_vencer", solicitadaEn: new Date(Date.now() - 16 * 86_400_000).toISOString(), respuestaVenceEn: new Date(Date.now() + 4 * 86_400_000).toISOString(), ejecucionVenceEn: null, notaResolucion: null },
  ]);
const TRANSICIONES_ARCO: Readonly<Record<string, readonly string[]>> = { recibida: ["en_proceso", "bloqueada", "resuelta", "rechazada"], en_proceso: ["bloqueada", "resuelta", "rechazada"], bloqueada: ["resuelta", "rechazada"] };

interface EntradaAuditoria {
  id: string;
  actorUserId: string;
  action: string;
  entityType: string;
  entityId: string | null;
  campo: string | null;
  antes: string | null;
  despues: string | null;
  creadoEn: string;
}
function auditoriaSemilla(): EntradaAuditoria[] {
  const tipos = ["servicio", "cita", "staff", "configuracion", "lista_espera"];
  return Array.from({ length: 30 }, (_, i) => ({
    id: `aud-${i + 1}`,
    actorUserId: "usr-asistente",
    action: i % 2 === 0 ? "actualizar" : "crear",
    entityType: tipos[i % tipos.length]!,
    entityId: `ent-${i + 1}`,
    campo: i % 2 === 0 ? "precio" : null,
    antes: i % 2 === 0 ? "650.00" : null,
    despues: i % 2 === 0 ? "700.00" : null,
    creadoEn: new Date(Date.now() - i * 3_600_000).toISOString(),
  }));
}

const CONFIG_MENSAJES = {
  reminderEnabled: true,
  reminderText: null,
  reminderLeadHours: 24,
  confirmationEnabled: true,
  confirmationText: null,
  cancellationEnabled: true,
  cancellationText: null,
  rescheduleEnabled: false,
  rescheduleText: null,
  sendWindowStart: 8,
  sendWindowEnd: 21,
};
const TEXTOS_MENSAJES: Readonly<Record<string, string>> = {
  recordatorio: "Hola {{nombre}}, te recordamos tu cita de {{servicio}} el {{fecha}} a las {{hora}}.",
  confirmacion: "Tu cita de {{servicio}} quedo confirmada para el {{fecha}} a las {{hora}}.",
  cancelacion: "Tu cita de {{servicio}} del {{fecha}} fue cancelada.",
  reagendado: "Tu cita de {{servicio}} se movio al {{fecha}} a las {{hora}}.",
};
const CAMPO_DE: Readonly<Record<string, [string, string]>> = {
  recordatorio: ["reminderText", "reminderEnabled"],
  confirmacion: ["confirmationText", "confirmationEnabled"],
  cancelacion: ["cancellationText", "cancellationEnabled"],
  reagendado: ["rescheduleText", "rescheduleEnabled"],
};
interface EstadoMensajes {
  version: number;
  config: Record<string, unknown>;
  actualizadoEn: string | null;
  historial: { version: number; accion: "actualizado" | "restablecido"; nuevo: Record<string, unknown>; diferencias: { campo: string; antes: string; despues: string }[]; actorNombre: string | null; creadoEn: string }[];
}
const mensajes = (p: Peticion) => p.estado.obtener<EstadoMensajes>(clave("citas.qa.mensajes", p), () => ({ version: 1, config: { ...CONFIG_MENSAJES }, actualizadoEn: null, historial: [] }));
function vistaPrevia(config: Record<string, unknown>) {
  return Object.keys(TEXTOS_MENSAJES).map((kind) => {
    const [texto, activo] = CAMPO_DE[kind]!;
    const propio = config[texto] as string | null;
    return { kind, activo: config[activo] === true, texto: (propio ?? TEXTOS_MENSAJES[kind]!).replace("{{nombre}}", "Ana").replace("{{servicio}}", "Limpieza dental").replace("{{fecha}}", "lunes 5 de octubre").replace("{{hora}}", "10:00"), esPorDefecto: propio === null };
  });
}
function diferencias(antes: Record<string, unknown>, despues: Record<string, unknown>) {
  return Object.keys(despues)
    .filter((k) => k !== "versionEsperada" && JSON.stringify(antes[k]) !== JSON.stringify(despues[k]))
    .map((campo) => ({ campo, antes: String(antes[campo] ?? ""), despues: String(despues[campo] ?? "") }));
}
const vistaMensajes = (m: EstadoMensajes) => ({ disponible: true, version: m.version, config: m.config, actualizadoEn: m.actualizadoEn, vistaPrevia: vistaPrevia(m.config) });

interface EventoPlantilla {
  evento: string;
  etiqueta: string;
  variables: string[];
  plantilla: { evento: string; nombre: string; idioma: string; variables: string[]; estado: string; aprobadaEn: string | null; actualizadaEn: string } | null;
}
const plantillas = (p: Peticion) =>
  p.estado.obtener<EventoPlantilla[]>(clave("citas.qa.plantillas", p), () => [
    { evento: "recordatorio", etiqueta: "Recordatorio de cita", variables: ["nombre", "fecha", "hora"], plantilla: { evento: "recordatorio", nombre: "citas_recordatorio_v1", idioma: "es_MX", variables: ["nombre", "fecha", "hora"], estado: "aprobada", aprobadaEn: new Date(Date.now() - 10 * 86_400_000).toISOString(), actualizadaEn: new Date(Date.now() - 10 * 86_400_000).toISOString() } },
    { evento: "lista_espera", etiqueta: "Aviso de lista de espera", variables: ["nombre", "fecha"], plantilla: null },
  ]);

interface Escalacion {
  id: string;
  canal: string;
  palabraClave: string;
  telefono: string;
  creadaEn: string;
  seguimiento: "pending" | "in_progress" | "resolved" | null;
  seguimientoEn: string | null;
  nota: string | null;
}
const escalaciones = (p: Peticion) =>
  p.estado.obtener<Escalacion[]>(clave("citas.qa.escalaciones", p), () => (esNorte(p) ? [] : [{ id: "esc-1", canal: "whatsapp", palabraClave: "emergencia", telefono: "***0202", creadaEn: new Date(Date.now() - 20 * 60_000).toISOString(), seguimiento: "pending", seguimientoEn: null, nota: null }]));

export const rutasCitasQaAdmin: readonly Ruta[] = [
  // Clientes
  {
    metodo: "GET",
    patron: `${P}/customers`,
    manejador: (p) => {
      const q = (p.query.get("search") ?? "").toLowerCase();
      const limite = Number(p.query.get("limit") ?? "50");
      const desde = Number(p.query.get("offset") ?? "0");
      const todos = clientes(p).filter((c) => !q || c.full_name.toLowerCase().includes(q) || c.phone.includes(q));
      const pagina = todos.slice(desde, desde + limite);
      return { customers: pagina, total: todos.length, next_offset: desde + limite < todos.length ? desde + limite : null };
    },
  },
  {
    metodo: "GET",
    patron: `${P}/customers/:cliId`,
    manejador: (p) => {
      const c = clientes(p).find((x) => x.id === p.params["cliId"]);
      if (!c) return fallo(404, "Cliente no encontrado.");
      const ahora = new Date().toISOString();
      return { customer: c, upcoming_appointments: citas(p).filter((x) => x.customer_id === c.id && x.starts_at >= ahora && VIVAS.has(x.status)) };
    },
  },
  {
    metodo: "PATCH",
    patron: `${P}/customers/:cliId`,
    manejador: (p) => {
      const c = clientes(p).find((x) => x.id === p.params["cliId"]);
      if (!c) return fallo(404, "Cliente no encontrado.");
      const email = ((p.cuerpo ?? {}) as { email?: string | null }).email ?? null;
      if (email !== null && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return fallo(400, "email: correo invalido");
      c.email = email;
      return { customer: c };
    },
  },
  // Proveedores
  {
    metodo: "POST",
    patron: `${P}/providers`,
    manejador: (p) => {
      const c = (p.cuerpo ?? {}) as { display_name?: string; role_label?: string };
      if (!c.display_name?.trim()) return fallo(400, "display_name: requerido");
      const nuevo: Proveedor = { id: `prv-nuevo-${proveedores(p).length + 1}`, property_id: p.params["id"]!, display_name: c.display_name.trim(), role_label: c.role_label ?? "", is_active: true };
      proveedores(p).push(nuevo);
      return conStatus(201, { provider: nuevo });
    },
  },
  {
    metodo: "GET",
    patron: `${P}/providers/:prvId`,
    manejador: (p) => {
      const prv = proveedorDe(p);
      if (!prv) return sinProveedor();
      const cal = calendarios(p, prv.id);
      return {
        provider: prv,
        availability_rules: reglas(p, prv.id),
        google_calendar: cal.google,
        calcom: { ...cal.calcom, sync_issues: { count: 0, last_reason: null } },
        caldav: { ...cal.caldav, sync_issues: { count: 0, last_reason: null } },
        calendar_sync_issues: prv.id === "prv-2" ? { count: 1, last_reason: "Cal.com exige el correo del cliente" } : { count: 0, last_reason: null },
        offered_service_ids: cal.ofrecidos,
      };
    },
  },
  {
    metodo: "PATCH",
    patron: `${P}/providers/:prvId`,
    manejador: (p) => {
      const prv = proveedorDe(p);
      if (!prv) return sinProveedor();
      const c = (p.cuerpo ?? {}) as { display_name?: string; role_label?: string; is_active?: boolean };
      if (c.display_name !== undefined && !c.display_name.trim()) return fallo(400, "display_name: requerido");
      if (c.display_name !== undefined) prv.display_name = c.display_name;
      if (c.role_label !== undefined) prv.role_label = c.role_label;
      if (c.is_active !== undefined) prv.is_active = c.is_active;
      return { provider: prv };
    },
  },
  {
    metodo: "PUT",
    patron: `${P}/providers/:prvId/services/:srvId`,
    manejador: (p) => {
      const prv = proveedorDe(p);
      if (!prv) return sinProveedor();
      const cal = calendarios(p, prv.id);
      const ofrecido = ((p.cuerpo ?? {}) as { offered?: boolean }).offered === true;
      cal.ofrecidos = ofrecido ? [...new Set([...cal.ofrecidos, p.params["srvId"]!])] : cal.ofrecidos.filter((x) => x !== p.params["srvId"]);
      return { ok: true };
    },
  },
  {
    metodo: "GET",
    patron: `${P}/providers/:prvId/google-calendar/connect`,
    manejador: (p) => (proveedorDe(p) ? { authorize_url: "about:blank#google-oauth-simulado" } : sinProveedor()),
  },
  ...(["calcom", "caldav"] as const).flatMap((tipo): Ruta[] => [
    {
      metodo: "POST",
      patron: `${P}/providers/:prvId/${tipo}/connect`,
      manejador: (p) => {
        const prv = proveedorDe(p);
        if (!prv) return sinProveedor();
        const c = (p.cuerpo ?? {}) as Record<string, string>;
        const cal = calendarios(p, prv.id);
        if (tipo === "calcom") {
          if (!c["api_key"] || !c["event_type_id"]) return fallo(400, "api_key y event_type_id son requeridos");
          cal.calcom = { connected: true, sync_status: "connected", sync_error: null, calcom_event_type_id: c["event_type_id"]!, calcom_base_url: c["base_url"] ?? null };
          return { connected: true, provider_id: prv.id, calcom_event_type_id: c["event_type_id"], calcom_base_url: c["base_url"] ?? null, sync_status: "connected" };
        }
        if (!c["calendar_collection_url"] || !c["username"] || !c["password"]) return fallo(400, "Faltan datos de CalDAV");
        cal.caldav = { connected: true, sync_status: "connected", sync_error: null, calendar_collection_url: c["calendar_collection_url"]!, username: c["username"]! };
        return { connected: true, provider_id: prv.id, calendar_collection_url: c["calendar_collection_url"], username: c["username"], sync_status: "connected" };
      },
    },
    {
      metodo: "POST",
      patron: `${P}/providers/:prvId/${tipo}/disconnect`,
      manejador: (p) => {
        const prv = proveedorDe(p);
        if (!prv) return sinProveedor();
        const cal = calendarios(p, prv.id);
        if (tipo === "calcom") cal.calcom = { connected: false, sync_status: "disconnected", sync_error: null, calcom_event_type_id: null, calcom_base_url: null };
        else cal.caldav = { connected: false, sync_status: "disconnected", sync_error: null, calendar_collection_url: null, username: null };
        return { ok: true };
      },
    },
    { metodo: "POST", patron: `${P}/providers/:prvId/${tipo}/test-connection`, manejador: (p) => (proveedorDe(p) ? { ok: true, checked_at: new Date().toISOString() } : sinProveedor()) },
  ]),
  {
    metodo: "POST",
    patron: `${P}/providers/:prvId/availability-rules`,
    manejador: (p) => {
      const prv = proveedorDe(p);
      if (!prv) return sinProveedor();
      const c = (p.cuerpo ?? {}) as { day_of_week?: number; start_time?: string; end_time?: string; is_active?: boolean };
      if (c.day_of_week === undefined || !HHMM.test(c.start_time ?? "") || !HHMM.test(c.end_time ?? "")) return fallo(400, "Horario invalido");
      if (c.start_time! >= c.end_time!) return fallo(400, "start_time debe ser menor que end_time");
      const r: Regla = { id: `rg-${prv.id}-n${reglas(p, prv.id).length + 1}`, day_of_week: c.day_of_week, start_time: `${c.start_time!.slice(0, 5)}:00`, end_time: `${c.end_time!.slice(0, 5)}:00`, is_active: c.is_active ?? true };
      reglas(p, prv.id).push(r);
      return conStatus(201, { availability_rule: r });
    },
  },
  {
    metodo: "PATCH",
    patron: `${P}/providers/:prvId/availability-rules/:rgId`,
    manejador: (p) => {
      const prv = proveedorDe(p);
      if (!prv) return sinProveedor();
      const r = reglas(p, prv.id).find((x) => x.id === p.params["rgId"]);
      if (!r) return fallo(404, "Horario no encontrado.");
      const c = (p.cuerpo ?? {}) as { start_time?: string; end_time?: string; is_active?: boolean };
      const ini = c.start_time ?? r.start_time;
      const fin = c.end_time ?? r.end_time;
      if (ini.slice(0, 5) >= fin.slice(0, 5)) return fallo(400, "start_time debe ser menor que end_time");
      r.start_time = `${ini.slice(0, 5)}:00`;
      r.end_time = `${fin.slice(0, 5)}:00`;
      if (c.is_active !== undefined) r.is_active = c.is_active;
      return { availability_rule: r };
    },
  },
  {
    metodo: "DELETE",
    patron: `${P}/providers/:prvId/availability-rules/:rgId`,
    manejador: (p) => {
      const prv = proveedorDe(p);
      if (!prv) return sinProveedor();
      const lista = reglas(p, prv.id);
      const i = lista.findIndex((x) => x.id === p.params["rgId"]);
      if (i < 0) return fallo(404, "Horario no encontrado.");
      lista.splice(i, 1);
      return { ok: true };
    },
  },
  { metodo: "GET", patron: `${P}/providers/:prvId/availability-overrides`, manejador: (p) => (proveedorDe(p) ? { availability_overrides: excepciones(p, p.params["prvId"]!) } : sinProveedor()) },
  {
    metodo: "PUT",
    patron: `${P}/providers/:prvId/availability-overrides/:fecha`,
    manejador: (p) => {
      const prv = proveedorDe(p);
      if (!prv) return sinProveedor();
      const c = (p.cuerpo ?? {}) as { is_closed?: boolean; start_time?: string | null; end_time?: string | null; reason?: string | null };
      if (!c.is_closed && (!c.start_time || !c.end_time || c.start_time >= c.end_time)) return fallo(400, "Horario de la excepcion invalido");
      const lista = excepciones(p, prv.id).filter((x) => x.override_date !== p.params["fecha"]);
      const o: Excepcion = { override_date: p.params["fecha"]!, is_closed: c.is_closed === true, start_time: c.is_closed ? null : c.start_time!, end_time: c.is_closed ? null : c.end_time!, reason: c.reason ?? null };
      lista.push(o);
      excepciones(p, prv.id).splice(0, Infinity, ...lista.sort((a, b) => a.override_date.localeCompare(b.override_date)));
      return { availability_override: o };
    },
  },
  {
    metodo: "DELETE",
    patron: `${P}/providers/:prvId/availability-overrides/:fecha`,
    manejador: (p) => {
      const prv = proveedorDe(p);
      if (!prv) return sinProveedor();
      const lista = excepciones(p, prv.id);
      const i = lista.findIndex((x) => x.override_date === p.params["fecha"]);
      if (i < 0) return fallo(404, "Excepcion no encontrada.");
      lista.splice(i, 1);
      return { ok: true };
    },
  },
  // Servicios
  {
    metodo: "GET",
    patron: `${P}/services/:srvId`,
    manejador: (p) => {
      const srv = servicios(p).find((x) => x.id === p.params["srvId"]);
      return srv ? { service: srv } : fallo(404, "Servicio no encontrado.");
    },
  },
  {
    metodo: "POST",
    patron: `${P}/services`,
    manejador: (p) => {
      const c = (p.cuerpo ?? {}) as { name?: string; duration_minutes?: number; price_cents?: number | null };
      if (!c.name?.trim() || !Number.isInteger(c.duration_minutes) || (c.duration_minutes ?? 0) <= 0) return fallo(400, "Servicio invalido");
      const nuevo: Servicio = { id: `srv-nuevo-${servicios(p).length + 1}`, name: c.name.trim(), duration_minutes: c.duration_minutes!, buffer_minutes_before: 0, buffer_minutes_after: 0, price_cents: c.price_cents ?? null, is_active: true };
      servicios(p).push(nuevo);
      return conStatus(201, { service: nuevo });
    },
  },
  {
    metodo: "PATCH",
    patron: `${P}/services/:srvId`,
    manejador: (p) => {
      const srv = servicios(p).find((x) => x.id === p.params["srvId"]);
      if (!srv) return fallo(404, "Servicio no encontrado.");
      const c = (p.cuerpo ?? {}) as Partial<Servicio>;
      if (c.name !== undefined && !c.name.trim()) return fallo(400, "name: requerido");
      if (c.price_cents !== undefined && c.price_cents !== null && (!Number.isInteger(c.price_cents) || c.price_cents < 0)) return fallo(400, "price_cents invalido");
      Object.assign(srv, Object.fromEntries(Object.entries(c).filter(([, v]) => v !== undefined)));
      return { service: srv };
    },
  },
  // Configuracion del negocio
  {
    metodo: "GET",
    patron: `${P}/tenant-config`,
    manejador: (p) => ({ tenant_config: p.estado.obtener(clave("citas.qa.config", p), () => ({ organization_id: ORG.id, rubro: "dental", default_timezone: "America/Merida", owner_notification_phone: "+529995550200" })) }),
  },
  {
    metodo: "PATCH",
    patron: `${P}/tenant-config`,
    manejador: (p) => {
      const actual = p.estado.obtener<Record<string, unknown>>(clave("citas.qa.config", p), () => ({ organization_id: ORG.id, rubro: "dental", default_timezone: "America/Merida", owner_notification_phone: "+529995550200" }));
      const c = (p.cuerpo ?? {}) as { rubro?: string; default_timezone?: string; owner_notification_phone?: string | null };
      if (c.default_timezone !== undefined) {
        try {
          new Intl.DateTimeFormat("en-US", { timeZone: c.default_timezone });
        } catch {
          return fallo(400, "default_timezone: zona horaria IANA invalida");
        }
      }
      Object.assign(actual, Object.fromEntries(Object.entries(c).filter(([, v]) => v !== undefined)));
      return { tenant_config: actual };
    },
  },
  // Primeros pasos
  {
    metodo: "GET",
    patron: `${P}/onboarding`,
    manejador: (p) => {
      const paso = (id: string, titulo: string, estado: string, req: boolean, ruta: string) => ({ id, titulo, descripcion: `Paso ${titulo.toLowerCase()}.`, estado, requeridoParaPublicar: req, detalle: null, ruta });
      const pasos = [
        paso("proveedor", "Agrega un proveedor", "completo", true, "proveedores"),
        paso("servicio", "Agrega un servicio", "completo", true, "servicios"),
        paso("asignacion", "Asigna servicios a proveedores", "completo", true, "proveedores"),
        paso("horario", "Define horarios", "completo", true, "disponibilidad"),
        paso("precio", "Pon precio a tus servicios", "completo", false, "servicios"),
        paso("whatsapp", "Conecta WhatsApp", "pendiente", true, "agente-whatsapp"),
        paso("recordatorios", "Revisa los recordatorios", "pendiente", false, "mensajes-whatsapp"),
        paso("cancelacion", "Politica de cancelacion", "pendiente", false, "configuracion"),
        paso("cita_prueba", "Haz una cita de prueba", "no_disponible", false, "agenda"),
      ];
      const completados = pasos.filter((x) => x.estado === "completo").length;
      return { propertyId: p.params["id"], pasos, completados, total: pasos.length, progresoPct: Math.round((completados / pasos.length) * 100), faltanParaPublicar: ["whatsapp"], listoParaRecibirCitas: false };
    },
  },
  // Staff
  { metodo: "GET", patron: `${P}/admin/staff/invitaciones`, roles: ["owner", "admin"], manejador: (p) => ({ invitations: invitaciones(p).map(invVista) }) },
  {
    metodo: "POST",
    patron: `${P}/admin/staff/invitaciones`,
    roles: ["owner", "admin"],
    manejador: (p) => {
      const c = (p.cuerpo ?? {}) as { email?: string; verticalRole?: string };
      if (!c.email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(c.email)) return fallo(400, "email: correo invalido");
      if (invitaciones(p).some((x) => x.email === c.email && x.status === "pending")) return fallo(409, "Ya hay una invitacion pendiente para ese correo.");
      const inv: Invitacion = { id: `inv-${invitaciones(p).length + 1}`, email: c.email, vertical_role: c.verticalRole ?? "staff", property_ids: null, status: "pending", expires_at: new Date(Date.now() + 7 * 86_400_000).toISOString(), created_at: new Date().toISOString() };
      invitaciones(p).push(inv);
      return conStatus(201, { ...invVista(inv), inviteToken: "tkn-simulado-no-es-credencial" });
    },
  },
  {
    metodo: "DELETE",
    patron: `${P}/admin/staff/invitaciones/:invId`,
    roles: ["owner", "admin"],
    manejador: (p) => {
      const inv = invitaciones(p).find((x) => x.id === p.params["invId"]);
      if (!inv) return fallo(404, "Invitacion no encontrada.");
      inv.status = "revoked";
      return { ok: true };
    },
  },
  { metodo: "GET", patron: `${P}/admin/staff/miembros`, roles: ["owner", "admin"], manejador: (p) => ({ miembros: miembros(p).map(miembroVista) }) },
  {
    metodo: "PATCH",
    patron: `${P}/admin/staff/miembros/:usrId`,
    roles: ["owner", "admin"],
    manejador: (p) => {
      const m = miembros(p).find((x) => x.id === p.params["usrId"]);
      if (!m) return fallo(404, "Miembro no encontrado.");
      const rol = ((p.cuerpo ?? {}) as { verticalRole?: string }).verticalRole ?? "";
      const mio = RANGO_ROL[p.persona?.rol ?? "staff"] ?? 0;
      if (m.id === p.persona?.id) return fallo(403, "No puedes cambiar tu propio rol.");
      if ((RANGO_ROL[rol] ?? 99) > mio || (RANGO_ROL[m.vertical_role] ?? 0) > mio) return fallo(403, "No puedes asignar un rol por encima del tuyo.");
      m.vertical_role = rol;
      return miembroVista(m);
    },
  },
  // Auditoria
  {
    metodo: "GET",
    patron: `${P}/admin/auditoria`,
    roles: ["owner", "admin"],
    manejador: (p) => {
      const tipo = p.query.get("tipo");
      const limite = Number(p.query.get("limit") ?? "50");
      const desde = Number(p.query.get("offset") ?? "0");
      const todos = p.estado.obtener(clave("citas.qa.auditoria", p), auditoriaSemilla).filter((x) => !tipo || x.entityType === tipo);
      return { disponible: true, total: todos.length, nextOffset: desde + limite < todos.length ? desde + limite : null, items: todos.slice(desde, desde + limite) };
    },
  },
  // Privacidad (ARCO)
  {
    metodo: "GET",
    patron: `${P}/admin/privacidad/solicitudes`,
    roles: ["owner", "admin"],
    manejador: (p) => {
      const estado = p.query.get("estado");
      const derecho = p.query.get("derecho");
      const items = solicitudes(p).filter((x) => (!estado || x.estado === estado) && (!derecho || x.derecho === derecho));
      return { disponible: true, total: items.length, nextOffset: null, plazos: { respuestaDias: 20, ejecucionDias: 15 }, items };
    },
  },
  {
    metodo: "PATCH",
    patron: `${P}/admin/privacidad/solicitudes/:sid/estado`,
    roles: ["owner", "admin"],
    manejador: (p) => {
      const s = solicitudes(p).find((x) => x.id === p.params["sid"]);
      if (!s) return fallo(404, "Solicitud no encontrada.");
      const c = (p.cuerpo ?? {}) as { estado?: string; nota?: string };
      if (!(TRANSICIONES_ARCO[s.estado] ?? []).includes(c.estado ?? "")) return fallo(409, "Esa transicion no esta permitida.");
      if (c.estado === "rechazada" && !c.nota) return fallo(400, "nota: obligatoria al rechazar");
      s.estado = c.estado!;
      s.notaResolucion = c.nota ?? null;
      return { id: s.id, estado: s.estado };
    },
  },
  // Avisos (con escalacion de crisis y seguimiento)
  {
    metodo: "GET",
    patron: `${P}/admin/avisos`,
    roles: ["owner", "admin"],
    manejador: (p) => {
      const pendientes = citas(p).filter((c) => c.status === "pending");
      return {
        generadoEn: new Date().toISOString(),
        porConfirmar: { horas: 72, total: pendientes.length, items: pendientes.map((c) => ({ id: c.id, iniciaEn: c.starts_at, proveedor: c.provider_name, servicio: c.service_name, origen: c.source })) },
        recordatorios: { visible: true, disponible: true, ventanaDias: 7, filas: [{ canal: "whatsapp", estado: "sent", total: 11 }, { canal: "email", estado: "sent", total: 2 }, { canal: "whatsapp", estado: "failed", total: 1 }, { canal: "whatsapp", estado: "dead", total: 2 }] },
        escalaciones: { visible: true, disponible: true, seguimientoDisponible: true, items: escalaciones(p) },
      };
    },
  },
  {
    metodo: "POST",
    patron: `${P}/admin/escalaciones/:escId/seguimiento`,
    roles: ["owner", "admin"],
    manejador: (p) => {
      const e = escalaciones(p).find((x) => x.id === p.params["escId"]);
      if (!e) return fallo(404, "Escalacion no encontrada.");
      const c = (p.cuerpo ?? {}) as { estado?: "in_progress" | "resolved"; nota?: string };
      if (c.estado !== "in_progress" && c.estado !== "resolved") return fallo(400, "estado invalido");
      if (e.seguimiento === "resolved") return fallo(409, "La escalacion ya esta resuelta.");
      e.seguimiento = c.estado;
      e.seguimientoEn = new Date().toISOString();
      e.nota = c.nota ?? e.nota;
      return { id: e.id, estado: e.seguimiento, en: e.seguimientoEn };
    },
  },
  // Voz (estado honesto de la escalera; la vista previa no se abre en e2e)
  {
    metodo: "GET",
    patron: `${P}/admin/voz/estado`,
    roles: ["owner", "admin"],
    manejador: (p) => banderas(p.estado).includes("voz-preview") ? {
      escalera: { operativa: true, escalones: [{ escalon: "gemini-3.8-live", configurado: true, detalle: "Listo." }, { escalon: "cascada-openrouter", configurado: true, detalle: "Listo." }] },
      precioMicroUsdPorMinuto: { "gemini-3.8-live": 23_000, "cascada-openrouter": 9_000 },
      preview: { disponible: true, motivo: null },
    } : ({
      escalera: { operativa: false, escalones: [{ escalon: "gemini-3.8-live", configurado: false, detalle: "Falta la llave del proveedor de voz." }, { escalon: "cascada-openrouter", configurado: false, detalle: "Falta la llave de OpenRouter." }] },
      precioMicroUsdPorMinuto: { "gemini-3.8-live": 23_000, "cascada-openrouter": 9_000 },
      preview: { disponible: false, motivo: "Requiere las llaves de voz del negocio." },
    }),
  },
  // Mensajes de WhatsApp
  { metodo: "GET", patron: `${P}/admin/whatsapp-mensajes`, roles: ["owner", "admin"], manejador: (p) => vistaMensajes(mensajes(p)) },
  {
    metodo: "GET",
    patron: `${P}/admin/whatsapp-mensajes/opciones`,
    roles: ["owner", "admin"],
    manejador: () => ({
      mensajes: Object.keys(TEXTOS_MENSAJES).map((kind) => ({ kind, etiqueta: kind[0]!.toUpperCase() + kind.slice(1), variables: ["nombre", "servicio", "fecha", "hora"], textoPorOmision: TEXTOS_MENSAJES[kind] })),
      porOmision: CONFIG_MENSAJES,
      limites: { texto: 600, anticipacionMin: 1, anticipacionMax: 72 },
    }),
  },
  { metodo: "GET", patron: `${P}/admin/whatsapp-mensajes/historial`, roles: ["owner", "admin"], manejador: (p) => ({ disponible: true, entradas: mensajes(p).historial }) },
  {
    metodo: "POST",
    patron: `${P}/admin/whatsapp-mensajes/vista-previa`,
    roles: ["owner", "admin"],
    manejador: (p) => {
      const m = mensajes(p);
      const nuevo = { ...m.config, ...((p.cuerpo ?? {}) as Record<string, unknown>) };
      return { vistaPrevia: vistaPrevia(nuevo), diferencias: diferencias(m.config, nuevo), version: m.version };
    },
  },
  {
    metodo: "PUT",
    patron: `${P}/admin/whatsapp-mensajes`,
    roles: ["owner", "admin"],
    manejador: (p) => {
      const m = mensajes(p);
      const c = { ...((p.cuerpo ?? {}) as Record<string, unknown>) };
      if (c["versionEsperada"] !== m.version) return fallo(409, "Otra persona guardo cambios: recarga para ver la version nueva.");
      delete c["versionEsperada"];
      const lead = Number(c["reminderLeadHours"]);
      if (!Number.isInteger(lead) || lead < 1 || lead > 72) return fallo(400, "reminderLeadHours: entre 1 y 72");
      const dif = diferencias(m.config, c);
      m.config = { ...m.config, ...c };
      m.version += 1;
      m.actualizadoEn = new Date().toISOString();
      m.historial.unshift({ version: m.version, accion: "actualizado", nuevo: m.config, diferencias: dif, actorNombre: p.persona?.fullName ?? null, creadoEn: m.actualizadoEn });
      return vistaMensajes(m);
    },
  },
  {
    metodo: "POST",
    patron: `${P}/admin/whatsapp-mensajes/restablecer`,
    roles: ["owner", "admin"],
    manejador: (p) => {
      const m = mensajes(p);
      if (((p.cuerpo ?? {}) as { versionEsperada?: number }).versionEsperada !== m.version) return fallo(409, "Otra persona guardo cambios: recarga para ver la version nueva.");
      const dif = diferencias(m.config, CONFIG_MENSAJES);
      m.config = { ...CONFIG_MENSAJES };
      m.version += 1;
      m.actualizadoEn = new Date().toISOString();
      m.historial.unshift({ version: m.version, accion: "restablecido", nuevo: m.config, diferencias: dif, actorNombre: p.persona?.fullName ?? null, creadoEn: m.actualizadoEn });
      return vistaMensajes(m);
    },
  },
  // Plantillas HSM
  { metodo: "GET", patron: `${P}/admin/whatsapp-plantillas`, roles: ["owner", "admin"], manejador: (p) => ({ disponible: true, estados: ["borrador", "enviada", "aprobada", "rechazada"], eventos: plantillas(p) }) },
  {
    metodo: "PUT",
    patron: `${P}/admin/whatsapp-plantillas/:evento`,
    roles: ["owner", "admin"],
    manejador: (p) => {
      const ev = plantillas(p).find((x) => x.evento === p.params["evento"]);
      if (!ev) return fallo(404, "Evento desconocido.");
      const c = (p.cuerpo ?? {}) as { nombre?: string; idioma?: string; variables?: string[]; estado?: string };
      if (!c.nombre || !/^[a-z0-9_]+$/.test(c.nombre)) return fallo(400, "nombre: solo minusculas, numeros y guion bajo");
      ev.plantilla = { evento: ev.evento, nombre: c.nombre, idioma: c.idioma ?? "es_MX", variables: c.variables ?? [], estado: c.estado ?? "borrador", aprobadaEn: c.estado === "aprobada" ? new Date().toISOString() : null, actualizadaEn: new Date().toISOString() };
      return { disponible: true, plantilla: ev.plantilla };
    },
  },
  {
    metodo: "DELETE",
    patron: `${P}/admin/whatsapp-plantillas/:evento`,
    roles: ["owner", "admin"],
    manejador: (p) => {
      const ev = plantillas(p).find((x) => x.evento === p.params["evento"]);
      if (!ev?.plantilla) return fallo(404, "Plantilla no encontrada.");
      ev.plantilla = null;
      return { ok: true };
    },
  },
];

// Agente de WhatsApp (version con control de concurrencia y conexion del numero; nada sale a Meta)
interface EstadoAgente {
  version: number;
  config: { agentName: string | null; toneStyle: string | null; greetingText: string | null; rulesText: string | null };
  actualizadoEn: string | null;
  numero: { phoneNumberId: string; activo: boolean } | null;
}
const agente = (p: Peticion) => p.estado.obtener<EstadoAgente>(clave("citas.qa.agente", p), () => ({ version: 1, config: { agentName: null, toneStyle: null, greetingText: null, rulesText: null }, actualizadoEn: null, numero: { phoneNumberId: "100200300", activo: true } }));
function panelAgente(a: EstadoAgente) {
  return {
    disponible: true,
    agente: { version: a.version, config: a.config, actualizadoEn: a.actualizadoEn, promptDeMuestra: `Eres ${a.config.agentName ?? "la asistente"} de la clinica.` },
    conexion: a.numero
      ? { numero: a.numero, estado: a.numero.activo ? "registrado" : "pausado", credencialDeEnvioDisponible: true, nota: a.numero.activo ? "Número registrado." : "Número en pausa." }
      : { numero: null, estado: "sin_numero", credencialDeEnvioDisponible: true, nota: "Sin número conectado." },
    opciones: { tonos: [{ valor: "calido_cercano", etiqueta: "Cálido y cercano" }, { valor: "formal_directo", etiqueta: "Formal y directo" }], limites: { agentName: 60, greetingText: 300, rulesMaxLines: 10, ruleLength: 200, rulesText: 2000 } },
  };
}
const difAgente = (antes: Record<string, unknown>, despues: Record<string, unknown>) => diferencias(antes, despues);
export const rutasCitasQaAgente: readonly Ruta[] = [
  { metodo: "GET", patron: `${P}/admin/whatsapp-agente`, roles: ["owner", "admin"], manejador: (p) => panelAgente(agente(p)) },
  {
    metodo: "POST",
    patron: `${P}/admin/whatsapp-agente/vista-previa`,
    roles: ["owner", "admin"],
    manejador: (p) => {
      const a = agente(p);
      const nuevo = { ...a.config, ...((p.cuerpo ?? {}) as Record<string, unknown>) };
      return { prompt: `Eres ${String(nuevo["agentName"] ?? "la asistente")} de la clinica.`, diferencias: difAgente(a.config, nuevo), version: a.version };
    },
  },
  {
    metodo: "PUT",
    patron: `${P}/admin/whatsapp-agente`,
    roles: ["owner", "admin"],
    manejador: (p) => {
      const a = agente(p);
      const c = { ...((p.cuerpo ?? {}) as Record<string, unknown>) };
      if (c["versionEsperada"] !== a.version) return fallo(409, "La configuración cambió mientras la editabas: recarga para ver la versión nueva.");
      delete c["versionEsperada"];
      a.config = { ...a.config, ...(c as Partial<EstadoAgente["config"]>) };
      a.version += 1;
      a.actualizadoEn = new Date().toISOString();
      return { agente: panelAgente(a).agente };
    },
  },
  {
    metodo: "POST",
    patron: `${P}/admin/whatsapp-agente/restablecer`,
    roles: ["owner", "admin"],
    manejador: (p) => {
      const a = agente(p);
      if (((p.cuerpo ?? {}) as { versionEsperada?: number }).versionEsperada !== a.version) return fallo(409, "La configuración cambió mientras la editabas.");
      a.config = { agentName: null, toneStyle: null, greetingText: null, rulesText: null };
      a.version += 1;
      return { agente: panelAgente(a).agente };
    },
  },
  {
    metodo: "PUT",
    patron: `${P}/admin/whatsapp-agente/conexion`,
    roles: ["owner", "admin"],
    manejador: (p) => {
      const c = (p.cuerpo ?? {}) as { phoneNumberId?: string; activo?: boolean };
      if (!c.phoneNumberId || !/^\d{6,20}$/.test(c.phoneNumberId)) return fallo(400, "phoneNumberId: solo dígitos (6 a 20)");
      const a = agente(p);
      a.numero = { phoneNumberId: c.phoneNumberId, activo: c.activo !== false };
      return { conexion: panelAgente(a).conexion };
    },
  },
  {
    metodo: "DELETE",
    patron: `${P}/admin/whatsapp-agente/conexion`,
    roles: ["owner", "admin"],
    manejador: (p) => {
      const a = agente(p);
      a.numero = null;
      return { conexion: panelAgente(a).conexion };
    },
  },
];

function invVista(i: Invitacion) {
  return { id: i.id, email: i.email, verticalRole: i.vertical_role, propertyIds: i.property_ids, status: i.status, expiresAt: i.expires_at, createdAt: i.created_at };
}
function miembroVista(m: Miembro) {
  return { id: m.id, email: m.email, fullName: m.full_name, verticalRole: m.vertical_role, propertyIds: m.property_ids };
}

export const citasQa = { orgSlug: ORG.slug, propertyId: PROP.id, sucursalNorte: SUCURSAL_NORTE };
