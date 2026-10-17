// Rn-P3-08 -- puerto de datos del pre-check-in. Separado de RentasRepository a proposito (mismo criterio que RentasAccesoRepository): son
// tablas y funciones de la migracion 036, que pueden no existir todavia en la base real (`disponible: false`, nunca un 500).
import type { ConfigPrecheckin, EntradaCapturaDb, InfoPrecheckin, ResultadoCapturaDb, ResultadoPrecheckin, VerificacionPrecheckinDb } from "./tipos.ts";

export interface RentasPrecheckinRepository {
  // ---- publico (sesion de sistema, auth.uid() NULL: la API publica no tiene usuario) ----
  /** `valor: null` si la property no existe o no es de rentas. */
  obtenerInfo(propertyId: string): Promise<ResultadoPrecheckin<InfoPrecheckin | null>>;
  /** Empareja codigo + ultimos 4 dentro de la property, cuenta los fallos y, si coincide, guarda el token (solo su hash). Nunca lanza por un intento incorrecto. */
  verificar(propertyId: string, codigo: string, ultimos4: string, claveHash: string, tokenHash: string): Promise<ResultadoPrecheckin<VerificacionPrecheckinDb>>;
  /** Consume el token (un solo uso) y guarda correo, WhatsApp y aceptaciones. */
  capturar(entrada: EntradaCapturaDb): Promise<ResultadoPrecheckin<{ readonly resultado: ResultadoCapturaDb }>>;

  // ---- staff (sesion del request, RLS real: can_manage_acceso) ----
  obtenerConfig(propertyId: string): Promise<ResultadoPrecheckin<ConfigPrecheckin>>;
  /** Guarda el reglamento (`null` = no pedirlo). Sube la version solo si el texto cambia. */
  guardarReglamento(organizationId: string, propertyId: string, reglamento: string | null, actorId: string): Promise<ResultadoPrecheckin<ConfigPrecheckin>>;
}
