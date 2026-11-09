// Tipos y rotulos del "Equipo" de una organizacion (alta del equipo inicial por superadmin, SA-L-26 minimo). La forma es la de
// apps/api/src/routes/superadmin-organizaciones-equipo.ts: el correo llega ENMASCARADO y nunca hay hashes ni tokens.
import { etiquetasTraducidas, traductorActivo } from "@atiende/ui";
import type { Clave } from "@atiende/ui";
import { superadminEquipo } from "@atiende/ui/i18n/superadmin/equipo";

const tr = traductorActivo(superadminEquipo);

export interface EquipoMiembro {
  readonly userId: string;
  readonly correo: string;
  readonly rol: string;
  readonly platformRole: string;
  /** null = todas las sucursales. */
  readonly propertyIds: readonly string[] | null;
  readonly altaEn: string;
}

export interface EquipoInvitacion {
  readonly id: string;
  readonly correo: string;
  readonly rol: string;
  readonly platformRole: string;
  readonly propertyIds: readonly string[] | null;
  readonly creadaEn: string;
  readonly venceEn: string;
  readonly vencida: boolean;
}

export interface EquipoSucursal {
  readonly id: string;
  readonly nombre: string;
  readonly estado: string;
}

export interface RespuestaEquipo {
  readonly disponible: boolean;
  /** Vertical de la organizacion (migracion 0070); ausente contra una base con solo la 0053 (entonces solo hay roles de restaurantes). */
  readonly vertical?: string;
  readonly mensaje: string | null;
  readonly miembros: readonly EquipoMiembro[];
  readonly invitaciones: readonly EquipoInvitacion[];
  readonly sucursales: readonly EquipoSucursal[];
}

/** Resultado de crear/reenviar: el enlace de activacion se muestra UNA sola vez. */
export interface ResultadoInvitacion {
  readonly invitacion: { readonly id: string; readonly correo: string; readonly verticalRole: string; readonly venceEn: string };
  readonly inviteToken: string;
  readonly acceptUrl: string;
  readonly correoEncolado: boolean;
}

export interface RolEquipo {
  readonly valor: string;
  readonly nombre: string;
  /** El rol da platform_role owner (dueño): invitar un segundo pide confirmacion. */
  readonly esDueno: boolean;
}

/** Rol invitable con su rotulo en el idioma activo (getter: traduce en cada lectura). */
const rol = (valor: string, clave: Clave, esDueno: boolean): RolEquipo => ({
  valor,
  get nombre() {
    return tr(clave);
  },
  esDueno,
});

/** Roles de la lista blanca de cada vertical (la base valida la lista, migracion 0070; aqui solo los rotulos). */
export const ROLES_EQUIPO_POR_VERTICAL: Readonly<Record<string, readonly RolEquipo[]>> = {
  restaurantes: [
    rol("owner", "superadmin.equipo.rol.owner", true),
    rol("admin", "superadmin.equipo.rol.admin", false),
    rol("staff", "superadmin.equipo.rol.staff", false),
    rol("repartidor", "superadmin.equipo.rol.repartidor", false),
  ],
  citas: [
    rol("owner", "superadmin.equipo.rol.owner", true),
    rol("admin", "superadmin.equipo.rol.admin", false),
    rol("staff", "superadmin.equipo.rol.staff", false),
  ],
  hoteles: [
    rol("owner", "superadmin.equipo.rol.owner", true),
    rol("gm", "superadmin.equipo.rol.gm", false),
    rol("frontdesk", "superadmin.equipo.rol.frontdesk", false),
    rol("reservations", "superadmin.equipo.rol.reservations", false),
    rol("housekeeping", "superadmin.equipo.rol.housekeeping", false),
    rol("maintenance", "superadmin.equipo.rol.maintenance", false),
    rol("fnb", "superadmin.equipo.rol.fnb", false),
    rol("accountant", "superadmin.equipo.rol.accountant", false),
  ],
  despachos: [
    rol("admin", "superadmin.equipo.rol.duenoDespacho", true),
    rol("contador", "superadmin.equipo.rol.contador", false),
    rol("auditor", "superadmin.equipo.rol.auditor", false),
    rol("readonly", "superadmin.equipo.rol.soloLectura", false),
  ],
  licitaciones: [
    rol("owner", "superadmin.equipo.rol.owner", true),
    rol("admin", "superadmin.equipo.rol.admin", false),
    rol("analyst", "superadmin.equipo.rol.analyst", false),
    rol("writer", "superadmin.equipo.rol.writer", false),
    rol("reviewer", "superadmin.equipo.rol.reviewer", false),
    rol("viewer", "superadmin.equipo.rol.soloLectura", false),
  ],
  rentas: [
    rol("admin_gestora", "superadmin.equipo.rol.adminGestora", true),
    rol("operador:acceso_total", "superadmin.equipo.rol.operadorTotal", false),
    rol("operador:calendario_mensajeria", "superadmin.equipo.rol.operadorCalendarioMensajes", false),
    rol("operador:solo_calendario", "superadmin.equipo.rol.operadorCalendario", false),
    rol("contador", "superadmin.equipo.rol.contador", false),
    rol("limpieza", "superadmin.equipo.rol.limpieza", false),
  ],
};

/** Roles invitables para la vertical de la organizacion; sin vertical conocida, los de restaurantes (unico caso antes de 0070). */
export function rolesEquipoDe(vertical: string | undefined): readonly RolEquipo[] {
  return (vertical ? ROLES_EQUIPO_POR_VERTICAL[vertical] : undefined) ?? ROLES_EQUIPO_POR_VERTICAL.restaurantes ?? [];
}

/** Compatibilidad: roles de restaurantes. */
export const ROLES_EQUIPO: readonly RolEquipo[] = rolesEquipoDe("restaurantes");

export const NOMBRE_ROL_EQUIPO: Readonly<Record<string, string>> = etiquetasTraducidas(
  ["owner", "admin", "staff", "repartidor"] as const,
  (r) => (r === "repartidor" ? "superadmin.equipo.rol.repartidor" : (`superadmin.equipo.rolCorto.${r}` as const)),
  superadminEquipo,
);

/** Rotulo del rol en la vertical de la organizacion (en despachos `admin` es el dueño). */
export function nombreRolEquipo(vertical: string | undefined, rol: string): string {
  if (!vertical || vertical === "restaurantes") return NOMBRE_ROL_EQUIPO[rol] ?? rol;
  return rolesEquipoDe(vertical).find((r) => r.valor === rol)?.nombre ?? rol;
}

export const MOTIVO_EQUIPO_MINIMO = 20;
