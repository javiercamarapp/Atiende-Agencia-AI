// Importador de historial (clientes con agregados y/o pedidos sueltos) -> plan, vista previa y reporte SIN PII.
// Principios (spec F1): dry-run por omision; idempotente por huella de fila; nunca crea pedidos ni consentimiento de marketing;
// no pisa lo que ya tiene un humano; ningun log/reporte lleva nombres, telefonos completos ni direcciones.
import { createHash } from "node:crypto";
import { canonicalizeMexicanPhone } from "../phone.ts";
import { fechaDia, limpiarArchivoHistorico, numero, type ClienteHistorico, type FilaRechazada, type OpcionesLimpieza } from "./limpieza.ts";
import { parsearArchivoHistorico } from "./csv.ts";

export type AccionImportacion = "crear" | "actualizar" | "sin_cambio";

export interface ExistenteHistorico {
  /** null = no hay cliente con ese telefono. */
  readonly customerId: string | null;
  /** Huella de la ultima importacion aplicada a ese cliente (null = nunca importado). */
  readonly huella: string | null;
  /** true = la telefono esta en la lista de supresion (ARCO): no se reimporta. */
  readonly suprimido?: boolean;
}

export interface PlanImportacion {
  readonly archivoSha256: string;
  readonly acciones: ReadonlyArray<{ readonly cliente: ClienteHistorico; readonly accion: AccionImportacion }>;
  readonly rechazos: readonly FilaRechazada[];
  readonly suprimidos: number;
}

export interface ReporteImportacion {
  readonly modo: "vista_previa" | "aplicado";
  readonly archivoSha256: string;
  readonly filasLeidas: number;
  readonly validas: number;
  readonly rechazadas: number;
  readonly rechazadasPorMotivo: Readonly<Record<string, number>>;
  readonly suprimidas: number;
  readonly creadas: number;
  readonly actualizadas: number;
  readonly sinCambios: number;
  readonly porBandera: Readonly<Record<string, number>>;
  readonly conDomicilioCompleto: number;
  readonly conFavoritos: number;
  readonly duplicadosPropuestos: number;
  /** Pares enmascarados `****1234 ~ ****5678`. */
  readonly paresDuplicados: readonly string[];
  /** Siempre 0: importar jamas otorga consentimiento de marketing. */
  readonly conConsentimientoMarketing: 0;
  readonly pedidosCreados: 0;
  /** Colonias con >= 5 clientes; el resto se agrupa en «otras» para no re-identificar. */
  readonly porColonia: Readonly<Record<string, number>>;
  readonly noImportado: readonly string[];
}

export const NO_IMPORTADO = [
  "texto de mensajes, audios, fotos y pines/ubicaciones exactas",
  "texto libre de quejas (solo la categoria)",
  "datos de pago mas alla del metodo; salud/alergias; datos de menores",
  "pedidos individuales como filas de orders (solo agregados en el resumen)",
  "consentimiento de marketing (siempre sin_registro)",
] as const;

const mask = (t: string) => `${"*".repeat(Math.max(0, t.length - 4))}${t.slice(-4)}`;

export function sha256Texto(t: string): string {
  return createHash("sha256").update(t).digest("hex");
}

/** Plan puro: decide la accion de cada cliente comparando su huella con la ultima aplicada. */
export function planificarImportacion(
  clientes: readonly ClienteHistorico[],
  rechazos: readonly FilaRechazada[],
  existentes: ReadonlyMap<string, ExistenteHistorico>,
  archivoSha256: string,
): PlanImportacion {
  const acciones: Array<{ cliente: ClienteHistorico; accion: AccionImportacion }> = [];
  let suprimidos = 0;
  for (const cliente of clientes) {
    const ex = existentes.get(cliente.telefono);
    if (ex?.suprimido) {
      suprimidos++;
      continue;
    }
    const accion: AccionImportacion = !ex || ex.customerId === null ? "crear" : ex.huella === cliente.huella ? "sin_cambio" : "actualizar";
    acciones.push({ cliente, accion });
  }
  return { archivoSha256, acciones, rechazos, suprimidos };
}

/** Reporte agregado, sin PII (solo conteos y telefonos enmascarados en los pares de duplicados). */
export function construirReporte(plan: PlanImportacion, filasLeidas: number, modo: ReporteImportacion["modo"]): ReporteImportacion {
  const cuenta = (a: AccionImportacion) => plan.acciones.filter((x) => x.accion === a).length;
  const porBandera: Record<string, number> = {};
  const porMotivo: Record<string, number> = {};
  for (const r of plan.rechazos) porMotivo[r.motivo] = (porMotivo[r.motivo] ?? 0) + 1;
  const colonias = new Map<string, number>();
  const pares = new Set<string>();
  let completos = 0;
  let conFavoritos = 0;
  for (const { cliente: c } of plan.acciones) {
    for (const b of c.banderas) porBandera[b] = (porBandera[b] ?? 0) + 1;
    if (c.direccion !== null && c.colonia !== null && !c.banderas.includes("colonia_pendiente_pedir_ubicacion")) completos++;
    if (c.favoritos.length > 0) conFavoritos++;
    const col = c.colonia ?? "(sin colonia)";
    colonias.set(col, (colonias.get(col) ?? 0) + 1);
    for (const d of c.duplicadoCon) pares.add([c.telefono, d].sort().map(mask).join(" ~ "));
  }
  const porColonia: Record<string, number> = {};
  let otras = 0;
  for (const [k, v] of [...colonias].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) {
    if (v >= 5 && Object.keys(porColonia).length < 10) porColonia[k] = v;
    else otras += v;
  }
  if (otras > 0) porColonia["otras"] = otras;
  return {
    modo,
    archivoSha256: plan.archivoSha256,
    filasLeidas,
    validas: plan.acciones.length + plan.suprimidos,
    rechazadas: plan.rechazos.length,
    rechazadasPorMotivo: porMotivo,
    suprimidas: plan.suprimidos,
    creadas: cuenta("crear"),
    actualizadas: cuenta("actualizar"),
    sinCambios: cuenta("sin_cambio"),
    porBandera,
    conDomicilioCompleto: completos,
    conFavoritos,
    duplicadosPropuestos: pares.size,
    paresDuplicados: [...pares].sort(),
    conConsentimientoMarketing: 0,
    pedidosCreados: 0,
    porColonia,
    noImportado: NO_IMPORTADO,
  };
}

/** Reporte en markdown (solo conteos). */
export function reporteMarkdown(r: ReporteImportacion): string {
  const tabla = (o: Readonly<Record<string, number>>) => (Object.keys(o).length === 0 ? "- (ninguno)" : Object.entries(o).sort().map(([k, v]) => `- ${k}: ${v}`).join("\n"));
  return [
    `# Reporte de importacion historica (${r.modo})`,
    `Archivo sha256: ${r.archivoSha256}`,
    `Filas leidas: ${r.filasLeidas} | validas: ${r.validas} | rechazadas: ${r.rechazadas} | suprimidas (ARCO): ${r.suprimidas}`,
    `Crear: ${r.creadas} | actualizar: ${r.actualizadas} | sin cambio: ${r.sinCambios}`,
    `Con domicilio completo: ${r.conDomicilioCompleto} | con favoritos: ${r.conFavoritos} | duplicados propuestos: ${r.duplicadosPropuestos}`,
    `Consentimiento de marketing otorgado: 0 | pedidos creados: 0`,
    "## Rechazos por motivo", tabla(r.rechazadasPorMotivo),
    "## Banderas", tabla(r.porBandera),
    "## Colonias (>=5 clientes)", tabla(r.porColonia),
    "## Pares de duplicados (enmascarados)", r.paresDuplicados.length === 0 ? "- (ninguno)" : r.paresDuplicados.map((p) => `- ${p}`).join("\n"),
    "## No se importa", ...r.noImportado.map((x) => `- ${x}`),
  ].join("\n");
}

/** Puerto de persistencia: el adaptador Postgres llama a `restaurantes.importar_historial` (migracion 140); las pruebas usan el de memoria. */
export interface PuertoHistorico {
  existentes(organizationId: string, telefonos: readonly string[]): Promise<ReadonlyMap<string, ExistenteHistorico>>;
  aplicar(organizationId: string, plan: PlanImportacion): Promise<void>;
}

export interface OpcionesImportacion extends OpcionesLimpieza {
  /** false (por omision) = vista previa: NO escribe. */
  readonly aplicar?: boolean;
}

/** Orquesta: parsea -> limpia -> compara contra lo existente -> (opcional) aplica -> reporte. */
export async function importarHistorial(
  organizationId: string,
  contenido: string | readonly unknown[],
  puerto: PuertoHistorico,
  opciones: OpcionesImportacion = {},
): Promise<{ plan: PlanImportacion; reporte: ReporteImportacion }> {
  const crudas = typeof contenido === "string" ? parsearArchivoHistorico(contenido) : contenido;
  const sha = sha256Texto(typeof contenido === "string" ? contenido : JSON.stringify(contenido));
  const { clientes, rechazos } = limpiarArchivoHistorico(crudas, opciones);
  const existentes = await puerto.existentes(organizationId, clientes.map((c) => c.telefono));
  const plan = planificarImportacion(clientes, rechazos, existentes, sha);
  const aplicar = opciones.aplicar === true;
  if (aplicar) await puerto.aplicar(organizationId, plan);
  return { plan, reporte: construirReporte(plan, crudas.length, aplicar ? "aplicado" : "vista_previa") };
}

// ---------------------------------------------------------------------------
// Pedidos sueltos -> agregados por cliente (NO se crean filas en orders)
// ---------------------------------------------------------------------------

/**
 * Un archivo de pedidos individuales (`celular`, `fecha`, `total`, `producto`/`items`) se pliega a un renglon por cliente con
 * los mismos campos que el de clientes (pedidos, gasto, ticket, primer/ultimo, favoritos = top 3 productos). Pedidos sin
 * telefono valido o sin fecha/total se descartan y se cuentan. Determinista (orden estable).
 */
export function agregarPedidosACliente(pedidos: readonly Record<string, unknown>[]): { filas: Array<Record<string, unknown>>; descartados: number } {
  type Acc = { n: number; gasto: number; primero: string; ultimo: string; productos: Map<string, number> };
  const por = new Map<string, Acc>();
  let descartados = 0;
  for (const p of pedidos) {
    const tel = canonicalizeMexicanPhone(String(p.celular ?? p.telefono ?? ""));
    const fecha = fechaDia(p.fecha ?? p.fecha_pedido);
    const total = numero(p.total ?? p.monto);
    if (tel === null || fecha === null || total === null || total < 0) {
      descartados++;
      continue;
    }
    const acc = por.get(tel) ?? { n: 0, gasto: 0, primero: fecha, ultimo: fecha, productos: new Map() };
    acc.n++;
    acc.gasto += total;
    if (fecha < acc.primero) acc.primero = fecha;
    if (fecha > acc.ultimo) acc.ultimo = fecha;
    const items = Array.isArray(p.items) ? p.items.map(String) : String(p.producto ?? p.items ?? "").split(/[;|]+/);
    for (const it of items) {
      const k = it.trim().toLowerCase();
      if (k !== "") acc.productos.set(k, (acc.productos.get(k) ?? 0) + 1);
    }
    por.set(tel, acc);
  }
  const filas = [...por.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([tel, a]) => ({
      celular: tel,
      pedidos: a.n,
      gasto_piso_mxn: Math.round(a.gasto * 100) / 100,
      ticket_mxn: Math.round((a.gasto / a.n) * 100) / 100,
      primer_pedido: a.primero,
      ultimo_pedido: a.ultimo,
      favoritos: [...a.productos].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0])).slice(0, 3).map(([k]) => k).join(";"),
    }));
  return { filas, descartados };
}

// ---------------------------------------------------------------------------
// Puerto en memoria (pruebas y vista previa sin base)
// ---------------------------------------------------------------------------
export class PuertoHistoricoMemoria implements PuertoHistorico {
  readonly clientes = new Map<string, { customerId: string; huella: string | null; cliente: ClienteHistorico | null }>();
  readonly suprimidos = new Set<string>();
  escrituras = 0;
  private seq = 0;

  async existentes(_org: string, telefonos: readonly string[]): Promise<ReadonlyMap<string, ExistenteHistorico>> {
    const m = new Map<string, ExistenteHistorico>();
    for (const t of telefonos) {
      const c = this.clientes.get(t);
      m.set(t, { customerId: c?.customerId ?? null, huella: c?.huella ?? null, suprimido: this.suprimidos.has(t) });
    }
    return m;
  }

  async aplicar(_org: string, plan: PlanImportacion): Promise<void> {
    for (const { cliente, accion } of plan.acciones) {
      if (accion === "sin_cambio") continue;
      this.escrituras++;
      const previo = this.clientes.get(cliente.telefono);
      this.clientes.set(cliente.telefono, { customerId: previo?.customerId ?? `c-${++this.seq}`, huella: cliente.huella, cliente });
    }
  }
}
