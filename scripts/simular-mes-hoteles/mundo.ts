// Tenant sintetico del simulador: 1 organizacion + 1 property de 40 habitaciones en 4 tipos, tarifas (por la API real), politicas,
// staff por rol con correos @example.test y el canal de WhatsApp. Lo que NO tiene endpoint (organizacion, membresias, inventario por
// noche, impuestos, politica de cancelacion, zona horaria, canal) se siembra por SQL como lo haria el alta de un cliente.
import { createHash, randomBytes } from "node:crypto";
import type { Client } from "pg";
import { hashPassword } from "@atiende/db";

export function uuidDe(clave: string): string {
  const h = createHash("sha1").update(`simulacion-hoteles:${clave}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export const ZONA = "America/Cancun";
export const PHONE_NUMBER_ID = "5550001001";
// Password del staff sintetico: se genera por corrida (solo vive en este proceso y en el Postgres efimero).
export const PASSWORD = `Sim-${randomBytes(18).toString("hex")}`;
export const RFC_EMISOR = "HSA0101019A1";

export type RolStaff = "owner" | "gm" | "frontdesk" | "frontdesk2" | "reservations" | "housekeeping" | "maintenance" | "fnb" | "accountant";

export interface TipoHab {
  readonly clave: "estandar" | "superior" | "suite_junior" | "suite_master";
  readonly nombre: string;
  readonly capacidad: number;
  readonly cuartos: number;
  readonly primerCodigo: number;
  readonly precioSemana: number;
  readonly precioFinDeSemana: number;
}

export const TIPOS: readonly TipoHab[] = [
  { clave: "estandar", nombre: "Estandar", capacidad: 2, cuartos: 16, primerCodigo: 101, precioSemana: 1200, precioFinDeSemana: 1450 },
  { clave: "superior", nombre: "Superior", capacidad: 3, cuartos: 12, primerCodigo: 201, precioSemana: 1800, precioFinDeSemana: 2150 },
  { clave: "suite_junior", nombre: "Suite Junior", capacidad: 4, cuartos: 8, primerCodigo: 301, precioSemana: 2800, precioFinDeSemana: 3300 },
  { clave: "suite_master", nombre: "Suite Master", capacidad: 4, cuartos: 4, primerCodigo: 401, precioSemana: 4500, precioFinDeSemana: 5200 },
];

export const STAFF: readonly { rol: RolStaff; verticalRole: string; platformRole: "owner" | "admin" | "member"; nombre: string }[] = [
  { rol: "owner", verticalRole: "owner", platformRole: "owner", nombre: "Duena Sintetica" },
  { rol: "gm", verticalRole: "gm", platformRole: "admin", nombre: "Gerente General" },
  { rol: "frontdesk", verticalRole: "frontdesk", platformRole: "member", nombre: "Recepcion Turno 1" },
  { rol: "frontdesk2", verticalRole: "frontdesk", platformRole: "member", nombre: "Recepcion Turno 2" },
  { rol: "reservations", verticalRole: "reservations", platformRole: "member", nombre: "Reservaciones" },
  { rol: "housekeeping", verticalRole: "housekeeping", platformRole: "member", nombre: "Ama de Llaves" },
  { rol: "maintenance", verticalRole: "maintenance", platformRole: "member", nombre: "Mantenimiento" },
  { rol: "fnb", verticalRole: "fnb", platformRole: "member", nombre: "Alimentos y Bebidas" },
  { rol: "accountant", verticalRole: "accountant", platformRole: "member", nombre: "Contabilidad" },
];

export interface Mundo {
  readonly organizationId: string;
  readonly propertyId: string;
  readonly slug: string;
  readonly staff: Readonly<Record<RolStaff, { id: string; email: string }>>;
  readonly tipos: Readonly<Record<TipoHab["clave"], { id: string; habitaciones: readonly { id: string; codigo: string }[] }>>;
}

export const correoDe = (rol: RolStaff) => `${rol}@hotel-sintetico.example.test`;

/** Siembra por SQL lo que no tiene endpoint. Los tipos de habitacion y habitaciones se crean por la API (ver main.ts) para ejercitarla. */
export async function sembrarBase(db: Client): Promise<Pick<Mundo, "organizationId" | "propertyId" | "slug" | "staff">> {
  const organizationId = uuidDe("org");
  const propertyId = uuidDe("property");
  const slug = "hotel-sintetico";
  await db.query(`insert into core.organization (id, vertical, name, slug, status) values ($1, 'hoteles', 'Hotel Sintetico Atiende', $2, 'active')`, [organizationId, slug]);
  await db.query(`insert into core.property (id, organization_id, vertical, name) values ($1, $2, 'hoteles', 'Hotel Sintetico Cancun')`, [propertyId, organizationId]);
  const hash = await hashPassword(PASSWORD);
  const staff: Record<string, { id: string; email: string }> = {};
  for (const s of STAFF) {
    const id = uuidDe(`staff:${s.rol}`);
    const email = correoDe(s.rol);
    await db.query(`insert into core.staff_user (id, email, full_name, password_hash, created_via, email_verified_at) values ($1, $2, $3, $4, 'seed', now())`, [id, email, s.nombre, hash]);
    await db.query(`insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values ($1, $2, null, $3, $4)`, [id, organizationId, s.platformRole, s.verticalRole]);
    staff[s.rol] = { id, email };
  }
  await db.query(`insert into hoteles.property_config (property_id, organization_id, timezone) values ($1, $2, $3)`, [propertyId, organizationId, ZONA]);
  await db.query(`insert into hoteles.tax_config (property_id, organization_id, iva_rate, ish_rate, discount_threshold, dsa_per_night, rfc_emisor) values ($1, $2, 0.16, 0.03, 500, 0, $3)`, [propertyId, organizationId, RFC_EMISOR]);
  await db.query(`insert into hoteles.cancellation_policy (property_id, organization_id, free_until_hours, penalty_pct) values ($1, $2, 48, 0.5)`, [propertyId, organizationId]);
  await db.query(`insert into hoteles.whatsapp_channel_config (property_id, organization_id, phone_number_id, enabled) values ($1, $2, $3, true)`, [propertyId, organizationId, PHONE_NUMBER_ID]);
  return { organizationId, propertyId, slug, staff: staff as Mundo["staff"] };
}

/** Inventario por noche (no hay endpoint: lo siembra el operador, como en los verify-*). Cubre [desde, hasta] por tipo. */
export async function sembrarInventario(db: Client, organizationId: string, propertyId: string, tipoId: string, cuartos: number, desde: string, hasta: string): Promise<void> {
  await db.query(
    `insert into hoteles.availability (organization_id, property_id, room_type_id, date, total_rooms)
     select $1, $2, $3, d::date, $4 from generate_series($5::date, $6::date, interval '1 day') d
     on conflict do nothing`,
    [organizationId, propertyId, tipoId, cuartos, desde, hasta],
  );
}
