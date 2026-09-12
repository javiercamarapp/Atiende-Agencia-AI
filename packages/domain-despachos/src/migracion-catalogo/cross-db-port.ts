// Puerto de `b2b_ai/features/migracion_catalogo/cross_db.py` — el módulo original
// abre DOS conexiones psycopg reales (origen SIEMPRE en modo `READ ONLY` a nivel de
// sesión Postgres) contra el esquema legacy específico del despacho origen
// (`cuentas_contables`: columnas `codigo, descripcion, nivel, naturaleza, grupo`;
// `asientos_contables`: columnas `cuenta_debito, cuenta_credito, monto, fecha`).
//
// Esto NO es un adaptador genérico portable: asume ese esquema legacy exacto, no
// una base de datos cualquiera del cliente. Conectarlo de verdad requiere:
//   1. Credenciales reales (DSN de origen Y de destino, dos hosts potencialmente
//      distintos) — nunca disponibles en este monorepo por diseño.
//   2. Confirmar que el esquema real del cliente coincide con el contrato de
//      columnas de arriba (o escribir un adaptador de traducción por cliente).
//
// Igual que `spei-matching.ts` con las llamadas a STP/Banxico, aquí se documenta el
// CONTRATO (el puerto que `matching.ts`/`migrador.ts` necesitan) sin fingir una
// conexión real — el dominio nunca hace I/O directo; cualquier adaptador real vive
// en infraestructura (apps/api), fuera de este paquete, y solo se activa con
// credenciales explícitas.
import type { CuentaCatalogo, PolizaOrigen } from "./types.ts";

/** Puerto de solo lectura hacia el catálogo/pólizas de la base ORIGEN — la
 * implementación real (con `read_only=true` forzado a nivel de sesión, igual que el
 * origen) requiere credenciales de un cliente concreto. */
export interface CatalogoOrigenPort {
  cargarCatalogo(): Promise<readonly CuentaCatalogo[]>;
  cargarPoliza(polizaId: string): Promise<PolizaOrigen | null>;
  listarIdsPolizasElegibles(filtro?: { readonly fechaInicio?: string; readonly fechaFin?: string }): Promise<readonly string[]>;
}

/** Puerto de lectura/escritura hacia el catálogo/pólizas migradas de la base
 * DESTINO — requiere credenciales reales de un cliente concreto. */
export interface CatalogoDestinoPort {
  cargarCatalogo(): Promise<readonly CuentaCatalogo[]>;
  polizaYaMigrada(polizaId: string): Promise<boolean>;
  cuentasExistentesIds(): Promise<ReadonlySet<string>>;
}

/** Adaptador fail-closed por default: cualquier intento de uso sin credenciales
 * reales conectadas falla explícitamente en vez de devolver datos vacíos que
 * pudieran malinterpretarse como "catálogo origen vacío, todo sin_match". Mismo
 * patrón fail-closed que `verificadorSpeiExternoPendiente`. */
export function crearAdaptadorFailClosed(nombre: "origen" | "destino"): CatalogoOrigenPort & CatalogoDestinoPort {
  const noConfigurado = (): never => {
    throw new Error(`Migración de catálogo: no hay una conexión real configurada hacia la base de ${nombre} — conecta credenciales reales antes de migrar (ver comentario de cabecera de cross-db-port.ts).`);
  };
  return {
    cargarCatalogo: async () => noConfigurado(),
    cargarPoliza: async () => noConfigurado(),
    listarIdsPolizasElegibles: async () => noConfigurado(),
    polizaYaMigrada: async () => noConfigurado(),
    cuentasExistentesIds: async () => noConfigurado(),
  };
}
