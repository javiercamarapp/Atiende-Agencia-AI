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

/** Roles de la lista blanca de restaurantes (la base valida la lista; aqui solo los rotulos). */
export const ROLES_EQUIPO: ReadonlyArray<{ readonly valor: string; readonly nombre: string }> = [
  { valor: "owner", nombre: "Dueño (owner)" },
  { valor: "admin", nombre: "Administrador (admin)" },
  { valor: "staff", nombre: "Equipo (staff)" },
  { valor: "repartidor", nombre: "Repartidor" },
];

export const NOMBRE_ROL_EQUIPO: Readonly<Record<string, string>> = { owner: "Dueño", admin: "Administrador", staff: "Equipo", repartidor: "Repartidor" };

export const MOTIVO_EQUIPO_MINIMO = 20;
