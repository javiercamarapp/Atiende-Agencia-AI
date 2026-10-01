// D-21 -- tipos y puerto de la cartera de clientes (ficha fiscal por property). Mismo patrón que el portal del
// cliente (portal-cliente/types.ts): repositorio propio, opcional en AppDeps, adaptador Postgres con SAVEPOINT.
import type { FichaClienteNormalizada, PeriodicidadPagos } from "./ficha.ts";
import type { TipoPersona } from "./rfc.ts";

export interface ClienteFichaRecord {
  readonly propertyId: string;
  readonly organizationId: string;
  readonly rfc: string;
  readonly tipoPersona: TipoPersona;
  readonly razonSocial: string;
  readonly regimenesFiscales: readonly string[];
  readonly cpFiscal: string;
  readonly periodicidad: PeriodicidadPagos;
  readonly responsableId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Un cliente del despacho (property de vertical despachos) con su ficha, o `ficha: null` si aún no la tiene. */
export interface ClienteCarteraRow {
  readonly propertyId: string;
  readonly nombre: string;
  readonly ficha: ClienteFichaRecord | null;
}

export interface CarteraResultado {
  /** `no_disponible`: la migración 018 todavía no está en esta base; `clientes` trae las properties SIN ficha. */
  readonly estado: "disponible" | "no_disponible";
  readonly clientes: readonly ClienteCarteraRow[];
}

/** La base todavía no tiene la migración 018 (cartera). Las rutas responden 503 "no disponible aún". */
export class CarteraNoDisponibleError extends Error {
  constructor() {
    super("La cartera de clientes todavía no está disponible en esta base (migración pendiente).");
    this.name = "CarteraNoDisponibleError";
  }
}
export class ClienteRfcDuplicadoError extends Error {
  constructor() {
    super("Ya existe un cliente con ese RFC en tu despacho.");
    this.name = "ClienteRfcDuplicadoError";
  }
}
export class CarteraSinPermisoError extends Error {
  constructor(message = "No tienes permiso para esta operación sobre la cartera.") {
    super(message);
    this.name = "CarteraSinPermisoError";
  }
}
export class CarteraDatosInvalidosError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CarteraDatosInvalidosError";
  }
}
export class CarteraTopeExcedidoError extends Error {
  constructor(message = "Alcanzaste el máximo de clientes de tu despacho.") {
    super(message);
    this.name = "CarteraTopeExcedidoError";
  }
}

export interface CarteraRepository {
  /** Todas las properties de despachos de la organización con su ficha (si la hay). El filtro por alcance de la membresía lo aplica la ruta. */
  listar(organizationId: string): Promise<CarteraResultado>;
  /** Ficha de UNA property; null si no tiene ficha o si la base aún no tiene la migración (nunca lanza por eso). */
  obtenerFicha(propertyId: string): Promise<ClienteFichaRecord | null>;
  /** Crea la property y su ficha en una sola transacción. */
  alta(organizationId: string, nombre: string, ficha: FichaClienteNormalizada): Promise<{ readonly propertyId: string }>;
  /** Crea o actualiza la ficha de una property existente (el RFC de una ficha ya creada no cambia). */
  guardarFicha(propertyId: string, ficha: FichaClienteNormalizada): Promise<void>;
}
