// Tipos y rotulos del "Equipo" de una organizacion (alta del equipo inicial por superadmin, SA-L-26 minimo). La forma es la de
// apps/api/src/routes/superadmin-organizaciones-equipo.ts: el correo llega ENMASCARADO y nunca hay hashes ni tokens.
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

/** Roles de la lista blanca de cada vertical (la base valida la lista, migracion 0070; aqui solo los rotulos). */
export const ROLES_EQUIPO_POR_VERTICAL: Readonly<Record<string, readonly RolEquipo[]>> = {
  restaurantes: [
    { valor: "owner", nombre: "Dueño (owner)", esDueno: true },
    { valor: "admin", nombre: "Administrador (admin)", esDueno: false },
    { valor: "staff", nombre: "Equipo (staff)", esDueno: false },
    { valor: "repartidor", nombre: "Repartidor", esDueno: false },
  ],
  citas: [
    { valor: "owner", nombre: "Dueño (owner)", esDueno: true },
    { valor: "admin", nombre: "Administrador (admin)", esDueno: false },
    { valor: "staff", nombre: "Equipo (staff)", esDueno: false },
  ],
  hoteles: [
    { valor: "owner", nombre: "Dueño (owner)", esDueno: true },
    { valor: "gm", nombre: "Gerente general (gm)", esDueno: false },
    { valor: "frontdesk", nombre: "Recepción", esDueno: false },
    { valor: "reservations", nombre: "Reservaciones", esDueno: false },
    { valor: "housekeeping", nombre: "Ama de llaves", esDueno: false },
    { valor: "maintenance", nombre: "Mantenimiento", esDueno: false },
    { valor: "fnb", nombre: "Alimentos y bebidas", esDueno: false },
    { valor: "accountant", nombre: "Contabilidad", esDueno: false },
  ],
  despachos: [
    { valor: "admin", nombre: "Dueño del despacho (admin)", esDueno: true },
    { valor: "contador", nombre: "Contador", esDueno: false },
    { valor: "auditor", nombre: "Auditor", esDueno: false },
    { valor: "readonly", nombre: "Solo lectura", esDueno: false },
  ],
  licitaciones: [
    { valor: "owner", nombre: "Dueño (owner)", esDueno: true },
    { valor: "admin", nombre: "Administrador (admin)", esDueno: false },
    { valor: "analyst", nombre: "Analista", esDueno: false },
    { valor: "writer", nombre: "Redactor", esDueno: false },
    { valor: "reviewer", nombre: "Revisor", esDueno: false },
    { valor: "viewer", nombre: "Solo lectura", esDueno: false },
  ],
  rentas: [
    { valor: "admin_gestora", nombre: "Dueño / gestora (admin_gestora)", esDueno: true },
    { valor: "operador:acceso_total", nombre: "Operador (acceso total)", esDueno: false },
    { valor: "operador:calendario_mensajeria", nombre: "Operador (calendario y mensajes)", esDueno: false },
    { valor: "operador:solo_calendario", nombre: "Operador (solo calendario)", esDueno: false },
    { valor: "contador", nombre: "Contador", esDueno: false },
    { valor: "limpieza", nombre: "Limpieza", esDueno: false },
  ],
};

/** Roles invitables para la vertical de la organizacion; sin vertical conocida, los de restaurantes (unico caso antes de 0070). */
export function rolesEquipoDe(vertical: string | undefined): readonly RolEquipo[] {
  return (vertical ? ROLES_EQUIPO_POR_VERTICAL[vertical] : undefined) ?? ROLES_EQUIPO_POR_VERTICAL.restaurantes ?? [];
}

/** Compatibilidad: roles de restaurantes. */
export const ROLES_EQUIPO: readonly RolEquipo[] = rolesEquipoDe("restaurantes");

export const NOMBRE_ROL_EQUIPO: Readonly<Record<string, string>> = { owner: "Dueño", admin: "Administrador", staff: "Equipo", repartidor: "Repartidor" };

/** Rotulo del rol en la vertical de la organizacion (en despachos `admin` es el dueño). */
export function nombreRolEquipo(vertical: string | undefined, rol: string): string {
  if (!vertical || vertical === "restaurantes") return NOMBRE_ROL_EQUIPO[rol] ?? rol;
  return rolesEquipoDe(vertical).find((r) => r.valor === rol)?.nombre ?? rol;
}

export const MOTIVO_EQUIPO_MINIMO = 20;
