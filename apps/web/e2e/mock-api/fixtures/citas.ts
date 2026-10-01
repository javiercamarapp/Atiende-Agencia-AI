// Fixtures de citas (Clinica Dental Mayab). Las respuestas del API de citas usan snake_case (ver lib/*-client.ts).
import { fallo } from "../respuestas.ts";
import { orgDe, propiedadDe } from "../personas.ts";
import type { Ruta } from "../tipos.ts";

const PROP = propiedadDe("citas");
const ORG = orgDe("citas");
const P = "/v1/citas/properties/:id";

const PROVEEDORES = [
  { id: "prv-1", property_id: PROP.id, display_name: "Dra. Paola Medina", role_label: "Odontologa", is_active: true },
  { id: "prv-2", property_id: PROP.id, display_name: "Dr. Luis Cetina", role_label: "Ortodoncista", is_active: true },
];
const SERVICIOS = [
  { id: "srv-1", name: "Limpieza dental", duration_minutes: 45, buffer_minutes_before: 0, buffer_minutes_after: 10, price_cents: 65000, is_active: true },
  { id: "srv-2", name: "Revision de ortodoncia", duration_minutes: 30, buffer_minutes_before: 0, buffer_minutes_after: 0, price_cents: 90000, is_active: true },
];
const CLIENTES = [
  { id: "cli-1", full_name: "Ana Lilia Pech", phone: "+529995550201", email: "ana.pech@example.test" },
  { id: "cli-2", full_name: "Mario Chan", phone: "+529995550202", email: null },
];

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
  provider_name: string;
  service_name: string;
  customer_name: string;
  customer_phone: string;
}

function citasSemilla(): Cita[] {
  // Relativas a "ahora" para caer siempre dentro de la semana que pide la agenda.
  const base = Date.now();
  const hora = 3_600_000;
  const mk = (id: string, delta: number, status: string, prv: number, srv: number, cli: number): Cita => ({
    id,
    property_id: PROP.id,
    provider_id: PROVEEDORES[prv]!.id,
    service_id: SERVICIOS[srv]!.id,
    customer_id: CLIENTES[cli]!.id,
    starts_at: new Date(base + delta * hora).toISOString(),
    ends_at: new Date(base + delta * hora + 45 * 60_000).toISOString(),
    status,
    source: "whatsapp",
    notes: null,
    provider_name: PROVEEDORES[prv]!.display_name,
    service_name: SERVICIOS[srv]!.name,
    customer_name: CLIENTES[cli]!.full_name,
    customer_phone: CLIENTES[cli]!.phone,
  });
  return [mk("apt-1", 1, "confirmed", 0, 0, 0), mk("apt-2", 3, "pending", 1, 1, 1)];
}

const conteo = (pending: number, confirmed: number) => ({ pending, confirmed, completed: 0, cancelled: 0, no_show: 0 });

export const rutasCitas: readonly Ruta[] = [
  { metodo: "GET", patron: "/v1/citas/:org/admin/branches", manejador: () => ({ branches: [{ propertyId: PROP.id, name: PROP.nombre }] }) },
  { metodo: "GET", patron: `${P}/resumen`, manejador: () => ({
      timezone: "America/Merida",
      generated_at: new Date().toISOString(),
      today: { date: new Date().toISOString().slice(0, 10), total: 2, by_status: conteo(1, 1) },
      week: { from_date: new Date().toISOString().slice(0, 10), to_date: new Date(Date.now() + 6 * 86_400_000).toISOString().slice(0, 10), total: 9, by_status: conteo(3, 6) },
      pending_to_confirm: 3,
      no_shows_last_30_days: 1,
      new_customers_last_30_days: 12,
    }) },
  { metodo: "GET", patron: `${P}/providers`, manejador: () => ({ providers: PROVEEDORES }) },
  { metodo: "GET", patron: `${P}/services`, manejador: () => ({ services: SERVICIOS }) },
  { metodo: "GET", patron: `${P}/customers`, manejador: () => ({ customers: CLIENTES, total: CLIENTES.length, next_offset: null }) },
  { metodo: "GET", patron: `${P}/appointments`, manejador: (p) => ({ appointments: p.estado.obtener("citas.lista", citasSemilla) }) },
  { metodo: "POST", patron: `${P}/appointments/:aptId/cancel`, manejador: (p) => {
      const cita = p.estado.obtener("citas.lista", citasSemilla).find((c) => c.id === p.params.aptId);
      if (!cita) return fallo(404, "Esa cita no existe");
      cita.status = "cancelled";
      return { appointment: cita };
    } },
  { metodo: "GET", patron: `${P}/waitlist`, manejador: () => ({ waitlist: [] }) },
];

export const citas = { orgSlug: ORG.slug, propertyId: PROP.id };
