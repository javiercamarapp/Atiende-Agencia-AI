// Puerto de `b2b_ai/features/reconciliation_agent/alerts.py` (`AlertEngine`) — reglas
// de alerta sobre movimientos bancarios: comisiones, transferencias propias,
// movimientos grandes no identificados, depósitos/retiros sin CFDI con escalamiento
// por antigüedad, duplicados, y discrepancia de ingresos declarados vs depositados
// (Art. 91 LISR). 100% lógica pura, sin llamadas externas — se porta completa.
import type { AlertaAntiguedad, MovimientoBancario, SeveridadAlerta } from "./types.ts";

export const UMBRAL_MOVIMIENTO_GRANDE = 50_000.0;
export const RATIO_DISCREPANCIA_INGRESOS = 1.15;

/** `AGING_BUCKETS` — se expone para quien necesite la severidad "cruda" por
 * antigüedad (independiente de las reglas 4/5, que la colapsan — ver más abajo). */
export const AGING_BUCKETS: ReadonlyArray<readonly [number, number, SeveridadAlerta]> = [
  [0, 7, "info"],
  [8, 15, "info"],
  [16, 30, "warning"],
  [31, 60, "warning"],
  [61, 999, "critical"],
];

export function severidadPorAntiguedad(days: number): SeveridadAlerta {
  for (const [low, high, sev] of AGING_BUCKETS) {
    if (days >= low && days <= high) return sev;
  }
  return "critical";
}

const PATRONES_COMISION = /comision|comisión|cargo por|iva comision|iva por comision|cuota manejo|tarifa|cargo servicio|mantenimiento cuenta/;
const PATRONES_TRANSFERENCIA_PROPIA = /transferencia entre cuentas|traspaso|transferencia propia|mismo titular/;

function diasDesde(fecha: string, hoy: Date): number {
  const d = new Date(`${fecha}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return 0;
  return Math.max(0, Math.round((hoy.getTime() - d.getTime()) / 86_400_000));
}

/**
 * Revisa UN movimiento bancario sin conciliar y produce sus alertas —
 * `AlertEngine._check_movement`. `hoy` es inyectable para pruebas determinísticas
 * (el origen usa `datetime.now()` implícitamente vía el cálculo de antigüedad).
 *
 * Nota de fidelidad (documentada, replicada tal cual): las reglas 4/5 (depósito/
 * retiro sin CFDI) NUNCA producen severidad "info" — colapsan `severidadPorAntiguedad`
 * a solo "warning" o "critical" (`severity === "critical" ? "critical" : "warning"`).
 * Y cuando `days > 30` se agrega SIEMPRE una alerta adicional `aging_escalation`
 * (severidad "critical"), ADEMÁS de la alerta de la regla 4/5 — un movimiento sin
 * conciliar con más de 60 días produce DOS alertas "critical" simultáneas. Es el
 * comportamiento real del origen, no un bug de esta implementación.
 */
export function revisarMovimiento(mov: MovimientoBancario, umbralMovimientoGrande = UMBRAL_MOVIMIENTO_GRANDE, hoy: Date = new Date()): AlertaAntiguedad[] {
  const desc = mov.descripcion.toLowerCase();
  const days = diasDesde(mov.fecha, hoy);

  if (PATRONES_COMISION.test(desc)) {
    return [
      {
        itemType: "bank",
        fecha: mov.fecha,
        monto: mov.monto,
        descripcion: mov.descripcion,
        daysUnreconciled: days,
        severity: "info",
        message: `Comisión bancaria de $${Math.abs(mov.monto).toFixed(2)} — gasto deducible (cuenta 6030200)`,
        rule: "bank_fee",
      },
    ];
  }

  if (PATRONES_TRANSFERENCIA_PROPIA.test(desc)) {
    return [
      {
        itemType: "bank",
        fecha: mov.fecha,
        monto: mov.monto,
        descripcion: mov.descripcion,
        daysUnreconciled: days,
        severity: "info",
        message: "Transferencia entre cuentas propias — excluida de conciliación fiscal",
        rule: "own_account_transfer",
      },
    ];
  }

  const alerts: AlertaAntiguedad[] = [];

  if (Math.abs(mov.monto) >= umbralMovimientoGrande) {
    alerts.push({
      itemType: "bank",
      fecha: mov.fecha,
      monto: mov.monto,
      descripcion: mov.descripcion,
      daysUnreconciled: days,
      severity: "critical",
      message: `Movimiento grande no identificado: $${Math.abs(mov.monto).toFixed(2)}`,
      rule: "large_unidentified_movement",
    });
  }

  const severidadCruda = severidadPorAntiguedad(days);
  const severidadColapsada: SeveridadAlerta = severidadCruda === "critical" ? "critical" : "warning";

  if (mov.monto > 0) {
    alerts.push({
      itemType: "bank",
      fecha: mov.fecha,
      monto: mov.monto,
      descripcion: mov.descripcion,
      daysUnreconciled: days,
      severity: severidadColapsada,
      message: `Depósito de $${mov.monto.toFixed(2)} sin CFDI relacionado (${days}d)`,
      rule: "deposit_no_cfdi",
    });
  } else if (mov.monto < 0) {
    alerts.push({
      itemType: "bank",
      fecha: mov.fecha,
      monto: mov.monto,
      descripcion: mov.descripcion,
      daysUnreconciled: days,
      severity: severidadColapsada,
      message: `Retiro de $${Math.abs(mov.monto).toFixed(2)} sin CFDI relacionado (${days}d)`,
      rule: "withdrawal_no_cfdi",
    });
  }

  if (days > 30) {
    alerts.push({
      itemType: "bank",
      fecha: mov.fecha,
      monto: mov.monto,
      descripcion: mov.descripcion,
      daysUnreconciled: days,
      severity: "critical",
      message: `Movimiento sin conciliar por ${days} días — escalamiento`,
      rule: "aging_escalation",
    });
  }

  return alerts;
}

/** `_check_duplicates` — agrupa por `(monto absoluto a 2 decimales, primeros 30
 * caracteres de la descripción normalizada)` y marca como duplicado cualquier par
 * dentro del mismo grupo cuya diferencia de fecha en DÍAS CALENDARIO sea <= 1 (no
 * 24h de reloj exactas — puede cubrir hasta ~47h reales, ej. 23:59 vs 00:01 del día
 * siguiente; documentado tal cual el origen, no se "corrige" el criterio). */
export function revisarDuplicados(movimientos: readonly MovimientoBancario[]): AlertaAntiguedad[] {
  const grupos = new Map<string, number[]>();
  movimientos.forEach((m, i) => {
    const clave = `${Math.abs(m.monto).toFixed(2)}_${m.descripcion.slice(0, 30).toLowerCase().trim()}`;
    const arr = grupos.get(clave) ?? [];
    arr.push(i);
    grupos.set(clave, arr);
  });

  const alerts: AlertaAntiguedad[] = [];
  const yaMarcados = new Set<number>();
  for (const indices of grupos.values()) {
    if (indices.length < 2) continue;
    for (let a = 0; a < indices.length; a++) {
      for (let b = a + 1; b < indices.length; b++) {
        const m1 = movimientos[indices[a]!]!;
        const m2 = movimientos[indices[b]!]!;
        const d1 = new Date(`${m1.fecha}T00:00:00Z`);
        const d2 = new Date(`${m2.fecha}T00:00:00Z`);
        const diffDias = Math.round(Math.abs(d1.getTime() - d2.getTime()) / 86_400_000);
        if (diffDias <= 1) {
          for (const idx of [indices[a]!, indices[b]!]) {
            if (yaMarcados.has(idx)) continue;
            yaMarcados.add(idx);
            const m = movimientos[idx]!;
            alerts.push({
              itemType: "bank",
              fecha: m.fecha,
              monto: m.monto,
              descripcion: m.descripcion,
              daysUnreconciled: 0,
              severity: "warning",
              message: `Posible pago duplicado: $${Math.abs(m.monto).toFixed(2)} — "${m.descripcion}"`,
              rule: "duplicate_payment",
            });
          }
        }
      }
    }
  }
  return alerts;
}

/** `check_income_discrepancy` — Art. 91 LISR: depósitos totales vs ingreso
 * declarado. `null` si `declaredIncome<=0` (no hay base de comparación). */
export function revisarDiscrepanciaIngresos(totalDeposits: number, declaredIncome: number, ratioUmbral = RATIO_DISCREPANCIA_INGRESOS): AlertaAntiguedad | null {
  if (declaredIncome <= 0) return null;
  const ratio = totalDeposits / declaredIncome;
  if (ratio > ratioUmbral) {
    return {
      itemType: "bank",
      fecha: "",
      monto: totalDeposits - declaredIncome,
      descripcion: "Discrepancia entre depósitos bancarios e ingresos declarados",
      daysUnreconciled: 0,
      severity: "critical",
      message: `Depósitos ($${totalDeposits.toFixed(2)}) exceden el ingreso declarado ($${declaredIncome.toFixed(2)}) en más de ${((ratioUmbral - 1) * 100).toFixed(0)}% — Art. 91 LISR`,
      rule: "income_discrepancy_art91",
    };
  }
  return null;
}
