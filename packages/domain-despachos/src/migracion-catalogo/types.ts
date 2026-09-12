// Tipos de migración de catálogo contable entre bases de datos de clientes — puerto
// de `b2b_ai/features/migracion_catalogo/models.py` + `matching.py`.

export type TipoMatchMigracion = "exacto" | "alerta_riesgo" | "fuzzy" | "sin_match";
export type EstadoMapeoMigracion = "pendiente" | "aprobado" | "rechazado" | "editado";

/** `CuentaCatalogo` del origen (matching.py) — una cuenta de catálogo contable, de
 * cualquiera de los dos lados (origen o destino) de una migración. */
export interface CuentaCatalogo {
  readonly id: string;
  readonly codigo: string;
  readonly nombre: string;
  readonly nivel: number;
  /** "D" deudora | "A" acreedora — cualquier otro valor se trata como deudora, igual
   * que `calcular_saldo_cuenta_periodo` del origen (ver `verificacion.ts`). */
  readonly naturaleza: string;
  readonly tipoAgregado: string;
  readonly cuentaPadreCodigo: string | null;
}

/** `MapeoMigracionCuenta` — persistido, un mapeo propuesto o decidido entre una
 * cuenta origen y (opcionalmente) una cuenta destino. */
export interface MapeoMigracionCuenta {
  readonly id: string;
  readonly organizationId: string;
  readonly propertyId: string;
  readonly origenCuentaId: string;
  readonly destinoCuentaId: string | null;
  readonly tipoMatch: TipoMatchMigracion;
  readonly score: number; // 0-100, float (no Decimal — igual que el origen)
  readonly estado: EstadoMapeoMigracion;
  readonly aprobadoPor: string | null;
  readonly aprobadoEn: string | null; // ISO-8601
  readonly nota: string | null;
  readonly estrategiaConciliacionSaldos: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface NewMapeoMigracionInput {
  readonly organizationId: string;
  readonly propertyId: string;
  readonly origenCuentaId: string;
  readonly destinoCuentaId: string | null;
  readonly tipoMatch: TipoMatchMigracion;
  readonly score: number;
  readonly estado: EstadoMapeoMigracion;
  readonly nota: string | null;
}

/** Resultado de migrar una póliza — `ResultadoMigracionPoliza` del origen. */
export interface ResultadoMigracionPoliza {
  readonly polizaId: string;
  readonly migrada: boolean;
  readonly lineasMigradas: number;
  readonly bloqueada: boolean;
  readonly motivoBloqueo: string | null;
  readonly cuentasSinMapeoAprobado: readonly string[];
  readonly yaMigrada: boolean;
}

/** Una línea de póliza contable, del lado origen (aún no remapeada). */
export interface LineaPolizaOrigen {
  readonly cuentaOrigenId: string;
  readonly debe: number;
  readonly haber: number;
}

export interface PolizaOrigen {
  readonly polizaId: string;
  readonly fecha: string;
  readonly lineas: readonly LineaPolizaOrigen[];
}

// ---------------------------------------------------------------------------------
// Errores de dominio — puerto de las excepciones de `service.py`/`migrador.py`.
// ---------------------------------------------------------------------------------

export class MapeoNoEncontradoError extends Error {
  constructor(mapeoId: string) {
    super(`No existe el mapeo de migración "${mapeoId}".`);
    this.name = "MapeoNoEncontradoError";
  }
}

export class DecisionSinResponsableError extends Error {
  constructor() {
    super("decidido_por es obligatorio para aprobar, rechazar o editar un mapeo.");
    this.name = "DecisionSinResponsableError";
  }
}

export class TransicionEstadoInvalidaError extends Error {
  constructor(estadoActual: EstadoMapeoMigracion) {
    super(`Solo se puede decidir sobre un mapeo en estado "pendiente" (estado actual: "${estadoActual}").`);
    this.name = "TransicionEstadoInvalidaError";
  }
}

/** REQ-MIG-008, guardia 1:N — una misma cuenta origen ya migrando activamente hacia
 * OTRA cuenta destino distinta de la propuesta: rechazo total, sin excepción (ningún
 * campo lo autoriza — a diferencia de N:1, que sí tiene una vía con estrategia). */
export class DivisionUnoANoAutomaticaError extends Error {
  constructor(origenCuentaId: string, destinoActivoId: string, destinoPropuestoId: string) {
    super(`La cuenta origen "${origenCuentaId}" ya tiene un mapeo activo hacia "${destinoActivoId}"; no se permite dividirla automáticamente también hacia "${destinoPropuestoId}" (1:N).`);
    this.name = "DivisionUnoANoAutomaticaError";
  }
}

/** REQ-MIG-008, guardia N:1 — más de una cuenta origen activa hacia el mismo destino
 * requiere declarar cómo se concilian los saldos combinados. */
export class EstrategiaConciliacionRequeridaError extends Error {
  constructor(destinoCuentaId: string) {
    super(`Ya existe otra cuenta origen activa hacia el destino "${destinoCuentaId}" (N:1) — se requiere \`estrategiaConciliacionSaldos\` para confirmar.`);
    this.name = "EstrategiaConciliacionRequeridaError";
  }
}

export class PolizaDesbalanceadaError extends Error {
  constructor(polizaId: string, sumaDebe: number, sumaHaber: number) {
    super(`La póliza "${polizaId}" queda desbalanceada tras remapear cuentas (debe=${sumaDebe}, haber=${sumaHaber}).`);
    this.name = "PolizaDesbalanceadaError";
  }
}

export class DiscrepanciaConteoPolizasError extends Error {
  constructor(elegibles: number, migradas: number) {
    super(`El conteo de pólizas no cuadra: ${elegibles} elegibles en origen vs ${migradas} migradas en destino.`);
    this.name = "DiscrepanciaConteoPolizasError";
  }
}

export class DiscrepanciaBalancePolizaError extends Error {
  constructor(polizaId: string, diferencia: number) {
    super(`La póliza migrada "${polizaId}" no cuadra: diferencia debe/haber = ${diferencia}.`);
    this.name = "DiscrepanciaBalancePolizaError";
  }
}

export class DiscrepanciaCuadreSaldoError extends Error {
  constructor(cuentaDestinoId: string, diferencia: number, tolerancia: number) {
    super(`El saldo de la cuenta destino "${cuentaDestinoId}" no cuadra dentro de la tolerancia de ${tolerancia}: diferencia = ${diferencia}.`);
    this.name = "DiscrepanciaCuadreSaldoError";
  }
}

export class ReferenciasHuerfanasError extends Error {
  constructor(count: number) {
    super(`Se encontraron ${count} línea(s) migrada(s) cuya cuenta destino ya no existe en el catálogo.`);
    this.name = "ReferenciasHuerfanasError";
  }
}

export class CuentaContableNoEncontradaError extends Error {
  constructor(cuentaId: string) {
    super(`No se encontró la cuenta contable "${cuentaId}" — nunca se asume saldo $0 para una cuenta inexistente.`);
    this.name = "CuentaContableNoEncontradaError";
  }
}
