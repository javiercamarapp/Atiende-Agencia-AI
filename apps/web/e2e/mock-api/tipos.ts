// Tipos del servidor de API simulada para las pruebas E2E de apps/web.
// Sin dependencias externas: solo Node. NUNCA apunta a la base ni a Supabase reales y no usa secretos.

export type Vertical = "restaurantes" | "hoteles" | "rentas" | "despachos" | "licitaciones" | "citas";

/** Roles de organizacion que usan las fixtures. `finanzas` aplica a despachos/hoteles/rentas. */
export type Rol = "owner" | "admin" | "staff" | "finanzas";

export interface Persona {
  readonly id: string;
  readonly email: string;
  readonly fullName: string;
  readonly rol: Rol;
  /** `null` solo para el superadmin de plataforma (no pertenece a ninguna vertical). */
  readonly vertical: Vertical | null;
  readonly orgId: string;
  readonly orgSlug: string;
  readonly orgNombre: string;
  readonly isPlatformSuperadmin: boolean;
}

export interface RegistroPeticion {
  readonly seq: number;
  readonly ts: number;
  readonly metodo: string;
  /** Ruta con query string, tal como llego. */
  readonly ruta: string;
  readonly cuerpo: unknown;
  readonly persona: string | null;
  readonly status: number;
  /** `true` si ninguna ruta de las fixtures la atendio (se respondio 404 honesto). */
  readonly sinFixture: boolean;
  /** `true` si la respuesta fue forzada por una falla inyectada. */
  readonly inyectada: boolean;
}

/** Falla inyectable: responde `status` (y `cuerpo`) a las peticiones que coincidan, `veces` veces (0/omitido = siempre). */
export interface Falla {
  readonly metodo?: string;
  /** Subcadena de la ruta, o expresion regular entre barras: "/^\\/v1\\/hoteles\\//". */
  readonly ruta: string;
  readonly status: number;
  readonly cuerpo?: unknown;
  readonly veces?: number;
  readonly retrasoMs?: number;
}

export interface Peticion {
  readonly metodo: string;
  readonly ruta: string;
  readonly query: URLSearchParams;
  readonly cuerpo: unknown;
  readonly params: Readonly<Record<string, string>>;
  readonly persona: Persona | null;
  /** Cabeceras de la peticion (en minusculas), p. ej. `x-step-up-token` o `idempotency-key`. */
  readonly cabeceras: Readonly<Record<string, string | string[] | undefined>>;
  /** Estado mutable del escenario (aislado por prueba): fixtures lo usan para que un POST se refleje en el GET siguiente. */
  readonly estado: EstadoEscenario;
}

export interface EstadoEscenario {
  /** Devuelve el valor guardado bajo `clave`, inicializandolo con `semilla()` (una copia por escenario) la primera vez. */
  obtener<T>(clave: string, semilla: () => T): T;
  guardar(clave: string, valor: unknown): void;
}

export interface Respuesta {
  readonly status?: number;
  readonly cuerpo?: unknown;
}

export type Manejador = (peticion: Peticion) => Respuesta | unknown | Promise<Respuesta | unknown>;

export interface Ruta {
  readonly metodo: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** Patron con segmentos `:param`; `*` al final captura el resto. */
  readonly patron: string;
  /** Sin sesion: `/auth/google/status`, magic link y el canje del codigo. */
  readonly publica?: boolean;
  /** Si se indica, otros roles reciben 403. */
  readonly roles?: readonly Rol[];
  readonly manejador: Manejador;
}

/** Marca explicita de una respuesta con status distinto de 200. */
export const MARCA_RESPUESTA = Symbol.for("atiende.e2e.respuesta");
