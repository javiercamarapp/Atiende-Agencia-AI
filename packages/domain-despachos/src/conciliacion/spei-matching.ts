// Puerto de `b2b_ai/features/reconciliation_agent/spei.py` (`SPEIVerifier`) —
// MIXTO: el matching por clave de rastreo/RFC contra movimientos ya parseados es
// lógica propia 100% portable (se porta completa abajo); las dos llamadas reales a
// servicios externos (`_query_stp`, `_query_banxico_cep`) requieren credenciales
// reales de terceros y NO se portan como llamada real — se documenta el contrato
// exacto y se deja un adaptador fail-closed (mismo patrón que el resto del
// monorepo: nunca se simula un "verificado" sin la integración real conectada).
//
// Nota de auditoría (ver informe de esta fase): la URL base del origen para STP
// (`https://stp-api.i-banxico.gob.mx`) no corresponde a un endpoint público conocido
// del servicio real de STP (Sistema de Transferencias y Pagos, operado por una
// entidad distinta de Banxico), y la heurística de éxito de `_query_banxico_cep`
// (`status_code==200 and len(content)>1000`) asume un flujo de descarga directa de
// PDF que el CEP público real normalmente no permite sin captcha interactivo — es
// decir, ni siquiera en el origen Python hay evidencia de que estas dos llamadas
// funcionen contra los servicios productivos reales tal como están escritas. Por
// eso aquí se documenta el CONTRATO (qué payload se enviaría, qué se esperaría de
// vuelta) sin fingir una implementación funcional no verificada.
import type { MovimientoBancario } from "./types.ts";
import { fechaDiff as diffDias } from "./fechas.ts";

export interface ResultadoVerificacionSpei {
  readonly verified: boolean;
  readonly bestScore: number;
  readonly movementIdx: number | null;
}

/**
 * `verify_against_movements` — busca el movimiento cuyo score de coincidencia con
 * `claveRastreo`+`monto`+`fecha` sea mayor, y acepta si `score >= 60`. Puntajes
 * EXACTOS del origen:
 *   - Referencia: clave contenida en la referencia (o viceversa) → +60; si no,
 *     coincidencia de solo los primeros 8 caracteres de cada lado → +30.
 *   - Monto: diferencia absoluta < 0.01 → +30; diferencia relativa < 5% → +15.
 *   - Fecha: mismo día → +10; dentro de `dateToleranceDays` (default 3) → +5.
 */
export function verificarSpeiContraMovimientos(claveRastreo: string, monto: number, fecha: string, movimientos: readonly MovimientoBancario[], dateToleranceDays = 3): ResultadoVerificacionSpei {
  const clave = claveRastreo.trim().toLowerCase();
  let bestScore = 0;
  let bestIdx: number | null = null;

  movimientos.forEach((mov, idx) => {
    let score = 0;
    const ref = (mov.referencia ?? "").trim().toLowerCase();

    if (ref && clave && (clave.includes(ref) || ref.includes(clave))) {
      score += 60;
    } else if (ref.length >= 8 && clave.length >= 8 && (clave.slice(0, 8) === ref.slice(0, 8) || clave.slice(0, 8).includes(ref.slice(0, 8)) || ref.slice(0, 8).includes(clave.slice(0, 8)))) {
      score += 30;
    }

    const absMov = Math.abs(mov.monto);
    const absMonto = Math.abs(monto);
    if (Math.abs(absMov - absMonto) < 0.01) {
      score += 30;
    } else if (absMonto > 0 && Math.abs(absMov - absMonto) / absMonto < 0.05) {
      score += 15;
    }

    const dd = diffDias(mov.fecha, fecha);
    if (dd === 0) score += 10;
    else if (dd !== null && dd <= dateToleranceDays) score += 5;

    if (score > bestScore) {
      bestScore = score;
      bestIdx = idx;
    }
  });

  return { verified: bestScore >= 60, bestScore, movementIdx: bestIdx };
}

/**
 * `verify_pago_proveedor` — matching por RFC de proveedor. Puntajes EXACTOS:
 *   - RFC completo en la descripción → +50; prefijo de 6 caracteres → +25.
 *   - Monto exacto (<0.01) → +30; relativo <5% → +15.
 *   - Fecha exacta → +20; dentro de tolerancia → +10.
 *   - Umbral de aceptación: score >= 50 (distinto del umbral 60 de clave de rastreo).
 */
export function verificarPagoProveedor(rfc: string, monto: number, fecha: string, movimientos: readonly MovimientoBancario[], dateToleranceDays = 3): ResultadoVerificacionSpei {
  const rfcUpper = rfc.trim().toUpperCase();
  let bestScore = 0;
  let bestIdx: number | null = null;

  movimientos.forEach((mov, idx) => {
    let score = 0;
    const desc = `${mov.descripcion} ${mov.referencia ?? ""}`.toUpperCase();

    if (rfcUpper.length > 0 && desc.includes(rfcUpper)) {
      score += 50;
    } else if (rfcUpper.length >= 6 && desc.includes(rfcUpper.slice(0, 6))) {
      score += 25;
    }

    const absMov = Math.abs(mov.monto);
    const absMonto = Math.abs(monto);
    if (Math.abs(absMov - absMonto) < 0.01) {
      score += 30;
    } else if (absMonto > 0 && Math.abs(absMov - absMonto) / absMonto < 0.05) {
      score += 15;
    }

    const dd = diffDias(mov.fecha, fecha);
    if (dd === 0) score += 20;
    else if (dd !== null && dd <= dateToleranceDays) score += 10;

    if (score > bestScore) {
      bestScore = score;
      bestIdx = idx;
    }
  });

  return { verified: bestScore >= 50, bestScore, movementIdx: bestIdx };
}

// ---------------------------------------------------------------------------------
// Contrato fail-closed para las dos integraciones externas reales (documentadas,
// NO implementadas con una llamada de red real desde este paquete de dominio — el
// dominio nunca debe hacer I/O; un adaptador en la capa de infraestructura de
// apps/api implementaría este puerto si se decide conectar credenciales reales).
// ---------------------------------------------------------------------------------

export interface ConsultaSpeiInput {
  readonly claveRastreo: string;
  readonly fecha: string; // YYYY-MM-DD
}

export interface ConsultaSpeiResultado {
  readonly verified: boolean;
  readonly status: string;
  readonly monto: number | null;
  readonly fecha: string | null;
  readonly emisor: string | null;
  readonly receptor: string | null;
  readonly cepUrl: string | null;
  readonly error: string | null;
}

/** Puerto que implementaría una consulta real a STP y/o al CEP de Banxico. Sin una
 * implementación real conectada (credenciales `stpApiKey`/`banxicoToken`), el
 * adaptador correcto es uno que SIEMPRE devuelve `status: "pending_verification"` —
 * fail-closed, nunca inventa una verificación positiva. */
export interface VerificadorSpeiExternoPort {
  consultar(input: ConsultaSpeiInput): Promise<ConsultaSpeiResultado>;
}

/** Adaptador fail-closed por default — documenta el comportamiento del origen
 * cuando ninguna credencial está configurada (`status="pending_verification"`, sin
 * intentar red). */
export const verificadorSpeiExternoPendiente: VerificadorSpeiExternoPort = {
  async consultar(): Promise<ConsultaSpeiResultado> {
    return {
      verified: false,
      status: "pending_verification",
      monto: null,
      fecha: null,
      emisor: null,
      receptor: null,
      cepUrl: null,
      error: null,
    };
  },
};
