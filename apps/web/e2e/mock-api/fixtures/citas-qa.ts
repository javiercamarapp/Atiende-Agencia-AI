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

export const citasQa = { orgSlug: ORG.slug, propertyId: PROP.id, sucursalNorte: SUCURSAL_NORTE };
