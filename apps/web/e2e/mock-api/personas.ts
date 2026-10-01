// Sesiones/roles de prueba. Todo es ficticio: correos en el dominio reservado `example.test`
// (RFC 2606), identificadores sinteticos y ningun valor con forma de credencial.
import type { Persona, Rol, Vertical } from "./tipos.ts";

export const VERTICALES: readonly Vertical[] = ["restaurantes", "hoteles", "rentas", "despachos", "licitaciones", "citas"];
export const ROLES: readonly Rol[] = ["owner", "admin", "staff", "finanzas"];

const ORGS: Readonly<Record<Vertical, { readonly slug: string; readonly nombre: string }>> = {
  restaurantes: { slug: "taqueria-el-faro", nombre: "Taqueria El Faro" },
  hoteles: { slug: "hotel-casa-azul", nombre: "Hotel Casa Azul" },
  rentas: { slug: "rentas-sol-y-mar", nombre: "Rentas Sol y Mar" },
  despachos: { slug: "despacho-medina-asociados", nombre: "Despacho Medina y Asociados" },
  licitaciones: { slug: "constructora-peninsular", nombre: "Constructora Peninsular" },
  citas: { slug: "clinica-dental-mayab", nombre: "Clinica Dental Mayab" },
};

function idSintetico(prefijo: string, vertical: string): string {
  // UUID con forma valida y contenido obviamente falso.
  const hex = Buffer.from(`${prefijo}-${vertical}`).toString("hex").padEnd(32, "0").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export function orgDe(vertical: Vertical): { id: string; slug: string; nombre: string } {
  return { id: idSintetico("org", vertical), ...ORGS[vertical] };
}

/** Sucursal/propiedad unica por vertical (el `propertyId` que usan casi todas las rutas del API). */
export function propiedadDe(vertical: Vertical): { id: string; nombre: string } {
  const nombres: Record<Vertical, string> = {
    restaurantes: "Sucursal Centro",
    hoteles: "Hotel Casa Azul Centro",
    rentas: "Casa Playa Norte",
    despachos: "Contribuyente Comercial del Sureste SA de CV",
    licitaciones: "Constructora Peninsular",
    citas: "Consultorio Centro",
  };
  return { id: idSintetico("prop", vertical), nombre: nombres[vertical] };
}

export function personaDe(vertical: Vertical, rol: Rol): Persona {
  const org = orgDe(vertical);
  return {
    id: `${vertical}-${rol}`,
    email: `${rol}.${vertical}@example.test`,
    fullName: `${rol[0]!.toUpperCase()}${rol.slice(1)} ${vertical}`,
    rol,
    vertical,
    orgId: org.id,
    orgSlug: org.slug,
    orgNombre: org.nombre,
    isPlatformSuperadmin: false,
  };
}

export const SUPERADMIN: Persona = {
  id: "plataforma-superadmin",
  email: "superadmin@example.test",
  fullName: "Superadmin de plataforma",
  rol: "owner",
  vertical: null,
  orgId: idSintetico("org", "plataforma"),
  orgSlug: "plataforma",
  orgNombre: "Atiende (plataforma)",
  isPlatformSuperadmin: true,
};

/** Resuelve `<vertical>-<rol>` o `plataforma-superadmin`; `null` si no existe. */
export function resolverPersona(id: string): Persona | null {
  if (id === SUPERADMIN.id) return SUPERADMIN;
  for (const v of VERTICALES) {
    for (const r of ROLES) {
      if (id === `${v}-${r}`) return personaDe(v, r);
    }
  }
  return null;
}

export function organizacionesDe(persona: Persona): Array<{ id: string; slug: string; nombre: string; vertical: string; rol: string }> {
  if (!persona.vertical) return [];
  return [{ id: persona.orgId, slug: persona.orgSlug, nombre: persona.orgNombre, vertical: persona.vertical, rol: persona.rol }];
}
