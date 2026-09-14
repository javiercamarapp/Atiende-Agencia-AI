// Motor de reglas contables — puerto de
// `b2b_ai/features/bookkeeping/rules_engine.py::AccountingRulesEngine`.
// Funcional (sin clase con estado mutable), mismo estilo que
// `migracion-catalogo/matching.ts` — los mapeos custom (tenant/global) se
// pasan explícitos en vez de guardarse en un objeto con `this._custom_
// mappings` mutable.
import { CATALOGO_CUENTAS_SAT, DEFAULT_MAPPINGS, mappingKey } from "./catalogo.ts";
import type { AccountMapping, CfdiClassification, LineaPoliza, PolizaContable, TipoCfdiBookkeeping } from "./types.ts";

function r2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** Aproxima `str(float)` de Python para el mensaje de `Póliza desbalanceada`
 * (el origen interpola `f"debe={total_debe}"` sobre el float crudo — Python
 * siempre muestra al menos un decimal, `str(10000.0) == "10000.0"`, mientras
 * que JS `${10000}` da `"10000"`). Ver la misma nota de fidelidad en
 * `cierre-mensual/validaciones.ts::pyFloatStr`. */
function pyFloatStr(n: number): string {
  return Number.isInteger(n) ? `${n}.0` : String(n);
}

export interface MapeosCustom {
  /** Mapeos específicos de un tenant — máxima prioridad. */
  readonly porTenant?: Readonly<Record<string, Readonly<Record<string, AccountMapping>>>>;
  /** Mapeos globales custom (aplican a cualquier tenant) — segunda prioridad. */
  readonly global?: Readonly<Record<string, AccountMapping>>;
}

/** `get_mapping` — prioridad: tenant-específico > global custom > default. */
export function getMapping(tipoCfdi: TipoCfdiBookkeeping, categoria: string, tenantId = "", custom?: MapeosCustom): AccountMapping | null {
  const key = mappingKey(tipoCfdi, categoria);
  if (tenantId && custom?.porTenant?.[tenantId]?.[key]) return custom.porTenant[tenantId]![key]!;
  if (custom?.global?.[key]) return custom.global[key]!;
  return DEFAULT_MAPPINGS[key] ?? null;
}

/** `get_account_name` — nombre del catálogo SAT, o `Cuenta {code}` si no
 * existe (igual que el origen, nunca lanza por un código desconocido). */
export function getAccountName(code: string): string {
  return CATALOGO_CUENTAS_SAT[code] ?? `Cuenta ${code}`;
}

export function validateAccount(code: string): boolean {
  return code in CATALOGO_CUENTAS_SAT;
}

/** `generate_poliza` — cargo/abono determinado ENTERAMENTE por el mapeo (no
 * calculado); el IVA no se desglosa de un monto bruto por fórmula — llega
 * pre-separado en `classification.subtotal`/`.iva` desde el propio CFDI.
 * Retorna `null` si no hay mapeo para (tipoCfdi, categoria, tenantId) — el
 * llamador decide qué hacer (cola de revisión humana / categoría "otros"). */
export function generatePoliza(classification: CfdiClassification, tenantId = "", custom?: MapeosCustom): PolizaContable | null {
  const mapping = getMapping(classification.tipoCfdi, classification.categoria, tenantId, custom);
  if (!mapping) return null;

  const lineas: LineaPoliza[] = [];
  const { subtotal, iva } = classification;

  lineas.push({ cuenta: mapping.cargo, concepto: `${getAccountName(mapping.cargo)} - ${classification.descripcion}`, debe: subtotal, haber: 0, tipo: "cargo" });
  lineas.push({ cuenta: mapping.abono, concepto: getAccountName(mapping.abono), debe: 0, haber: subtotal, tipo: "abono" });

  if (iva > 0) {
    if (mapping.ivaCargo) {
      lineas.push({ cuenta: mapping.ivaCargo, concepto: `IVA acreditable - ${getAccountName(mapping.ivaCargo)}`, debe: iva, haber: 0, tipo: "cargo" });
      lineas.push({ cuenta: mapping.abono, concepto: `IVA trasladado - ${getAccountName(mapping.abono)}`, debe: 0, haber: iva, tipo: "abono" });
    } else if (mapping.ivaAbono) {
      lineas.push({ cuenta: mapping.cargo, concepto: "IVA trasladado cobrado", debe: iva, haber: 0, tipo: "cargo" });
      lineas.push({ cuenta: mapping.ivaAbono, concepto: `IVA trasladado - ${getAccountName(mapping.ivaAbono)}`, debe: 0, haber: iva, tipo: "abono" });
    }
  }

  const totalDebe = lineas.reduce((a, l) => a + l.debe, 0);
  const totalHaber = lineas.reduce((a, l) => a + l.haber, 0);

  return {
    tipo: mapping.polizaType,
    fecha: "",
    concepto: `CFDI ${classification.cfdiUuid} - ${classification.descripcion}`,
    referencia: classification.cfdiUuid,
    lineas,
    totalDebe: r2(totalDebe),
    totalHaber: r2(totalHaber),
    cuadrada: Math.abs(totalDebe - totalHaber) < 0.01,
    tenantId,
  };
}

/** `get_all_categories` — categorías conocidas (default + custom), orden
 * alfabético (`sorted(cats)` del origen). */
export function getAllCategories(custom?: MapeosCustom): readonly string[] {
  const cats = new Set<string>();
  for (const key of Object.keys(DEFAULT_MAPPINGS)) cats.add(key.split("|")[1]!);
  if (custom?.global) for (const key of Object.keys(custom.global)) cats.add(key.split("|")[1]!);
  if (custom?.porTenant) for (const map of Object.values(custom.porTenant)) for (const key of Object.keys(map)) cats.add(key.split("|")[1]!);
  return [...cats].sort();
}

// ---------------------------------------------------------------------------
// JournalEntryGenerator — puerto de journal_generator.py.
// ---------------------------------------------------------------------------

export interface EntradaManual {
  readonly cuenta: string;
  readonly debe?: number;
  readonly haber?: number;
  readonly concepto?: string;
}

/** `generate_adjustment` — póliza de diario manual; balancea por
 * construcción SOLO si el llamador manda entradas ya balanceadas (a
 * diferencia de `generatePoliza`, aquí no hay garantía estructural). */
export function generateAdjustment(fecha: string, concepto: string, entries: readonly EntradaManual[], tenantId = ""): PolizaContable {
  const lineas: LineaPoliza[] = entries.map((e) => {
    const debe = e.debe ?? 0;
    const haber = e.haber ?? 0;
    return { cuenta: e.cuenta, concepto: e.concepto ?? "", debe, haber, tipo: debe > 0 ? "cargo" : "abono" };
  });
  const totalDebe = r2(lineas.reduce((a, l) => a + l.debe, 0));
  const totalHaber = r2(lineas.reduce((a, l) => a + l.haber, 0));
  return {
    tipo: "diario",
    fecha,
    concepto,
    referencia: "",
    lineas,
    totalDebe,
    totalHaber,
    cuadrada: Math.abs(totalDebe - totalHaber) < 0.01,
    tenantId,
  };
}

export interface ActivoDepreciacion {
  readonly cuentaActivo?: string;
  readonly cuentaDepreciacion?: string;
  readonly cuentaGasto?: string;
  readonly monto: number;
}

/** `generate_depreciation_entry` — convención: cuenta de depreciación
 * acumulada por defecto `1540100` (cuenta activo + 100 en el origen; aquí,
 * mismo default literal que el Python, no una fórmula sobre el código). */
export function generateDepreciationEntry(fecha: string, activos: readonly ActivoDepreciacion[], tenantId = ""): PolizaContable {
  const entries: EntradaManual[] = [];
  for (const activo of activos) {
    const cuentaGasto = activo.cuentaGasto ?? "6020300";
    entries.push({ cuenta: cuentaGasto, debe: activo.monto, haber: 0, concepto: `Depreciación mensual - ${getAccountName(activo.cuentaActivo ?? "")}` });
    entries.push({ cuenta: activo.cuentaDepreciacion ?? "1540100", debe: 0, haber: activo.monto, concepto: "Depreciación acumulada" });
  }
  return generateAdjustment(fecha, "Póliza de depreciación mensual", entries, tenantId);
}

/** `generate_provision_entry` — provisión de nómina (aguinaldo, vacaciones,
 * PTU). */
export function generateProvisionEntry(fecha: string, tipo: string, monto: number, cuentaGasto: string, cuentaProvision: string, tenantId = ""): PolizaContable {
  const entries: EntradaManual[] = [
    { cuenta: cuentaGasto, debe: monto, haber: 0, concepto: `Provisión ${tipo}` },
    { cuenta: cuentaProvision, debe: 0, haber: monto, concepto: `Provisión ${tipo}` },
  ];
  return generateAdjustment(fecha, `Póliza de provisión — ${tipo}`, entries, tenantId);
}

/** `validate_poliza` — 6 checks NIF, devuelve lista de errores (vacía si es
 * válida). Idéntico orden/mensajes que el origen. */
export function validatePoliza(poliza: PolizaContable): readonly string[] {
  const errors: string[] = [];

  if (poliza.lineas.length < 2) errors.push("La póliza debe tener al menos 2 movimientos");

  const totalDebe = r2(poliza.lineas.reduce((a, l) => a + l.debe, 0));
  const totalHaber = r2(poliza.lineas.reduce((a, l) => a + l.haber, 0));
  if (Math.abs(totalDebe - totalHaber) > 0.01) errors.push(`Póliza desbalanceada: debe=${pyFloatStr(totalDebe)}, haber=${pyFloatStr(totalHaber)}`);

  for (const linea of poliza.lineas) {
    if (linea.debe < 0 || linea.haber < 0) errors.push(`Monto negativo en cuenta ${linea.cuenta}`);
  }
  for (const linea of poliza.lineas) {
    if (linea.debe > 0 && linea.haber > 0) errors.push(`Cuenta ${linea.cuenta} tiene debe y haber simultáneos`);
  }
  for (const linea of poliza.lineas) {
    if (linea.cuenta && !validateAccount(linea.cuenta)) errors.push(`Cuenta ${linea.cuenta} no existe en catálogo SAT`);
  }
  if (!poliza.fecha) errors.push("La póliza requiere fecha");

  return errors;
}
