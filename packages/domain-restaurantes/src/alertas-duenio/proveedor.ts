// Alertas al dueño por fallas del proveedor de WhatsApp (Meta), evaluadas sobre el resultado de UNA corrida del despachador
// (`/internal/whatsapp/dispatch`, cada 5 min). Sin PII: solo el catalogo y un codigo de proveedor.
//
//   * `restaurantes.whatsapp.token_invalido` (critica): Graph API respondio con error 190 (token invalido, vencido o revocado:
//     runbook de operacion del original). Inmediata: basta UN mensaje. Una por organizacion por dia.
//   * `restaurantes.proveedor.falla` (critica): N o mas fallas del proveedor (red o respuesta de Meta, ya reintentadas o muertas)
//     en la corrida y NINGUN envio exitoso de esa organizacion. Con el tick de 5 min, la corrida cubre la ventana de 10 min
//     del brief sin guardar estado entre ticks. Una por proveedor por dia.
//
// El error 190 NO cuenta ademas como "falla de proveedor": tiene su propia alerta, mas accionable (renovar el token).
import type { TenantDbSession } from "@atiende/core-tenancy";
import { emitirNotificacion } from "@atiende/db";
import { diaMerida } from "./dia.ts";

/** Fallas del proveedor en la corrida a partir de las cuales (sin ningun envio exitoso de la organizacion) se alerta. */
export const UMBRAL_FALLAS_PROVEEDOR = 3;
/** Codigo de Graph API para token invalido, vencido o revocado. */
export const GRAPH_CODIGO_TOKEN_INVALIDO = 190;

export interface ItemDespachoOrg {
  readonly organizationId: string;
  readonly outcome: string;
  /** El fallo vino de Meta o de la red hacia Meta (no de la configuracion ni del payload). */
  readonly proveedor?: boolean;
  readonly graphCode?: number;
}

export interface DiagnosticoProveedorOrg {
  readonly organizationId: string;
  readonly tokenInvalido: boolean;
  readonly proveedorFalla: boolean;
}

/** Funcion pura: agrupa por organizacion los items de la corrida y decide que alertas merecen. Orden estable por organizacion. */
export function evaluarSaludProveedor(items: readonly ItemDespachoOrg[], umbral: number = UMBRAL_FALLAS_PROVEEDOR): readonly DiagnosticoProveedorOrg[] {
  const porOrg = new Map<string, { fallas: number; enviados: number; token: boolean }>();
  for (const it of items) {
    const acc = porOrg.get(it.organizationId) ?? { fallas: 0, enviados: 0, token: false };
    if (it.outcome === "sent") acc.enviados += 1;
    else if ((it.outcome === "retry" || it.outcome === "dead") && it.proveedor === true) {
      if (it.graphCode === GRAPH_CODIGO_TOKEN_INVALIDO) acc.token = true;
      else acc.fallas += 1;
    }
    porOrg.set(it.organizationId, acc);
  }
  return [...porOrg.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([organizationId, a]) => ({ organizationId, tokenInvalido: a.token, proveedorFalla: a.enviados === 0 && a.fallas >= umbral }))
    .filter((d) => d.tokenInvalido || d.proveedorFalla);
}

export interface ResultadoAlertasProveedor {
  readonly evaluadas: number;
  readonly emitidas: number;
  readonly sinNuevas: number;
  readonly errores: number;
}

/** Emite las alertas de un diagnostico. Idempotente por (organizacion, dia de Merida): reintentar la corrida no repite el aviso. */
export async function emitirAlertasProveedor(session: TenantDbSession, diagnosticos: readonly DiagnosticoProveedorOrg[], now: Date): Promise<ResultadoAlertasProveedor> {
  const dia = diaMerida(now);
  let evaluadas = 0;
  let emitidas = 0;
  let sinNuevas = 0;
  let errores = 0;
  const contar = (estado: string): void => {
    evaluadas += 1;
    if (estado === "emitida") emitidas += 1;
    else if (estado === "sin_nuevas" || estado === "no_disponible") sinNuevas += 1;
    else errores += 1;
  };
  for (const d of diagnosticos) {
    if (d.tokenInvalido) {
      contar((await emitirNotificacion(session, { evento: "restaurantes.whatsapp.token_invalido", organizationId: d.organizationId, clave: `whatsapp:${dia}` })).estado);
    }
    if (d.proveedorFalla) {
      contar((await emitirNotificacion(session, { evento: "restaurantes.proveedor.falla", organizationId: d.organizationId, clave: `whatsapp:${dia}`, parametros: { proveedor: "whatsapp" } })).estado);
    }
  }
  return { evaluadas, emitidas, sinNuevas, errores };
}
