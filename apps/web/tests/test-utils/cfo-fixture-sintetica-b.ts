// CFO-08 · respuestas SINTÉTICAS de `/admin/cfo/{clientes,productos,patrones,operacion,softrestaurant/*}` para la API simulada de e2e
// (`e2e/mock-api/fixtures/restaurantes-cfo-b.ts`) y para las pruebas de componente. Mismo método que `cfo-fixture-sintetica.ts` (CFO-07): el generador
// SINTÉTICO de CFO-04 + el servicio REAL de CFO-05 sobre el repositorio en memoria; el resultado se versiona como JSON y
// `restaurantes-cfo-b-fixture-sintetica.spec.ts` falla si se desfasa (`ACTUALIZAR_FIXTURE_CFO=1` lo reescribe).
// Lo que el generador de CFO-04 no trae (cohortes, altas, canasta, entregas, repartidores, colonias, escalaciones) se deriva aquí de los pedidos
// sintéticos, con alias de cliente y colonias «SINTÉTICA»: nunca nombres, teléfonos ni direcciones.
import { InMemoryCfoRepository, ServicioCfo, derivarResumenDeCuentas, normalizarExportSr } from "@atiende/domain-restaurantes/cfo";
import type {
  ConsultaCfo,
  FilaAgotado,
  FilaCanastaPar,
  FilaCanastaTicket,
  FilaCanastaTotales,
  FilaClientesAltas,
  FilaClientesCohorte,
  FilaClientesSegmentoHora,
  FilaColonia,
  FilaEntregas,
  FilaEscalacionHora,
  FilaRepartidor,
  FilaSrResumen,
} from "@atiende/domain-restaurantes/cfo";
import { parsearCsvSr } from "@atiende/domain-restaurantes/cfo";
import { CSV_SR_SINTETICO, SUCURSALES_PM_SINTETICAS, costosCapturadosSinteticos, generarDatasetSintetico, type PedidoSintetico } from "../../../../packages/domain-restaurantes/tests/fixtures/cfo-pm-sintetico.ts";
import { AHORA, AVISO_SINTETICO, ID_T1, ID_T2, MES, ORG_SINTETICA, RANGO_ACTUAL } from "./cfo-fixture-sintetica.ts";

const SUC = SUCURSALES_PM_SINTETICAS;
const IDS = SUC.map((s) => s.propertyId);
const D = generarDatasetSintetico({ diasRango: 120 });

/** Selecciones que cubre la API simulada para las pestañas del CFO B. */
export const SELECCIONES_B: Readonly<Record<string, readonly string[] | null>> = { todas: null, t1: [ID_T1] };

const esVenta = (p: PedidoSintetico): boolean => (p.estado === "entregado" || p.estado === "completado") && !p.esReposicion;
const dia = (iso: string, n: number): string => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const diasEntre = (a: string, b: string): number => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
const dowIso = (iso: string): number => ((new Date(`${iso}T00:00:00Z`).getUTCDay() + 6) % 7) + 1;
const lunes = (iso: string): string => dia(iso, -(dowIso(iso) - 1));
function hash(s: string): number {
  let h = 2166136261;
  for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
  return h;
}

const VENTAS = D.pedidos.filter((p) => esVenta(p) && p.diaNegocio <= RANGO_ACTUAL.hasta);

// ---- Clientes: cohortes, altas y horario por segmento -------------------------------------------------------------------------------------

function primerasCompras(lista: readonly PedidoSintetico[]): Map<string, PedidoSintetico[]> {
  const m = new Map<string, PedidoSintetico[]>();
  for (const p of lista) m.set(p.clienteId, [...(m.get(p.clienteId) ?? []), p]);
  for (const v of m.values()) v.sort((a, b) => (a.diaNegocio < b.diaNegocio ? -1 : a.diaNegocio > b.diaNegocio ? 1 : 0));
  return m;
}

function cohortes(propertyId: string | null, lista: readonly PedidoSintetico[]): FilaClientesCohorte[] {
  const porMes = new Map<string, FilaClientesCohorte>();
  for (const orden of primerasCompras(lista).values()) {
    const primera = orden[0]!;
    const mes = primera.diaNegocio.slice(0, 7);
    const acum = porMes.get(mes) ?? { propertyId, mesCohorte: mes, clientes: 0, conRecompra30: 0, conRecompra60: 0, conRecompra90: 0, observables30: 0, observables60: 0, observables90: 0 };
    const edad = diasEntre(primera.diaNegocio, RANGO_ACTUAL.hasta);
    const sig = orden.slice(1).map((p) => diasEntre(primera.diaNegocio, p.diaNegocio));
    const con = (n: number): number => (sig.some((d) => d >= 1 && d <= n) ? 1 : 0);
    porMes.set(mes, {
      ...acum,
      clientes: acum.clientes + 1,
      conRecompra30: acum.conRecompra30 + con(30),
      conRecompra60: acum.conRecompra60 + con(60),
      conRecompra90: acum.conRecompra90 + con(90),
      observables30: acum.observables30 + (edad >= 30 ? 1 : 0),
      observables60: acum.observables60 + (edad >= 60 ? 1 : 0),
      observables90: acum.observables90 + (edad >= 90 ? 1 : 0),
    });
  }
  return [...porMes.values()].sort((a, b) => (a.mesCohorte < b.mesCohorte ? -1 : 1)).slice(-6);
}

function altas(propertyId: string | null, lista: readonly PedidoSintetico[]): FilaClientesAltas[] {
  const porSemana = new Map<string, number>();
  for (const orden of primerasCompras(lista).values()) {
    const s = lunes(orden[0]!.diaNegocio);
    porSemana.set(s, (porSemana.get(s) ?? 0) + 1);
  }
  return [...porSemana.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([semana, n]) => ({ propertyId, semana, altas: n }));
}

function segmentoHora(propertyId: string | null, lista: readonly PedidoSintetico[]): FilaClientesSegmentoHora[] {
  const ordenes = primerasCompras(lista);
  const m = new Map<string, { pedidos: number; neta: number; clientes: Set<string> }>();
  for (const p of lista) {
    if (p.diaNegocio < RANGO_ACTUAL.desde) continue;
    const orden = ordenes.get(p.clienteId)!;
    const enNoventa = orden.filter((x) => diasEntre(x.diaNegocio, RANGO_ACTUAL.hasta) < 90).length;
    const segmento = orden[0]!.diaNegocio >= RANGO_ACTUAL.desde ? "nuevo" : enNoventa >= 3 ? "frecuente" : "recurrente";
    const k = `${segmento}|${dowIso(p.diaNegocio)}|${p.horaLocal}`;
    const a = m.get(k) ?? { pedidos: 0, neta: 0, clientes: new Set<string>() };
    a.pedidos += 1;
    a.neta += p.netaCentavos;
    a.clientes.add(p.clienteId);
    m.set(k, a);
  }
  return [...m.entries()].sort(([x], [y]) => (x < y ? -1 : 1)).map(([k, a]) => {
    const [segmento, dow, hora] = k.split("|") as ["nuevo" | "recurrente" | "frecuente", string, string];
    return { propertyId, segmento, dowNegocio: Number(dow), horaLocal: Number(hora), pedidos: a.pedidos, netaCentavos: a.neta, clientes: a.clientes.size, pedidosPorCliente: Math.round((a.pedidos / a.clientes.size) * 100) / 100 };
  });
}

// ---- Canasta -----------------------------------------------------------------------------------------------------------------------------

function canasta(): { pares: FilaCanastaPar[]; totales: FilaCanastaTotales[]; tickets: FilaCanastaTicket[] } {
  const pares: FilaCanastaPar[] = [];
  const totales: FilaCanastaTotales[] = [];
  const tickets: FilaCanastaTicket[] = [];
  for (const s of SUC) {
    const lista = VENTAS.filter((p) => p.propertyId === s.propertyId && p.diaNegocio >= RANGO_ACTUAL.desde);
    const juntos = new Map<string, number>();
    const con: Record<string, number> = {};
    const nProd = new Map<number, { pedidos: number; neta: number }>();
    for (const p of lista) {
      const refs = [...new Set(p.items.map((i) => i.ref))].sort();
      for (const r of refs) con[r] = (con[r] ?? 0) + 1;
      for (let i = 0; i < refs.length; i++) for (let j = i + 1; j < refs.length; j++) juntos.set(`${refs[i]}|${refs[j]}`, (juntos.get(`${refs[i]}|${refs[j]}`) ?? 0) + 1);
      const n = Math.min(5, refs.length);
      const a = nProd.get(n) ?? { pedidos: 0, neta: 0 };
      nProd.set(n, { pedidos: a.pedidos + 1, neta: a.neta + p.netaCentavos });
    }
    totales.push({ propertyId: s.propertyId, pedidosTotales: lista.length, pedidosConProducto: con });
    for (const [k, n] of [...juntos.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 6)) {
      const [a, b] = k.split("|") as [string, string];
      pares.push({ propertyId: s.propertyId, productoA: a, productoB: b, pedidosJuntos: n });
    }
    for (const [n, a] of [...nProd.entries()].sort(([x], [y]) => x - y)) tickets.push({ propertyId: s.propertyId, nProductos: n, pedidos: a.pedidos, netaCentavos: a.neta });
  }
  return { pares, totales, tickets };
}

// ---- Operación: entregas, repartidores, escalaciones -------------------------------------------------------------------------------------

function entregas(): FilaEntregas[] {
  const m = new Map<string, FilaEntregas>();
  for (const p of VENTAS) {
    if (p.canal !== "domicilio" || p.entregaMin === null || p.diaNegocio < RANGO_ACTUAL.desde) continue;
    const k = `${p.propertyId}|${p.horaLocal}|${dowIso(p.diaNegocio)}`;
    const a = m.get(k) ?? { propertyId: p.propertyId, horaLocal: p.horaLocal, dowNegocio: dowIso(p.diaNegocio), entregados: 0, minSuma: 0, tarde: 0 };
    m.set(k, { ...a, entregados: a.entregados + 1, minSuma: a.minSuma + p.entregaMin, tarde: a.tarde + (p.entregaMin > 50 ? 1 : 0) });
  }
  return [...m.values()].sort((a, b) => (a.propertyId + a.horaLocal + a.dowNegocio < b.propertyId + b.horaLocal + b.dowNegocio ? -1 : 1));
}

function repartidores(): FilaRepartidor[] {
  const m = new Map<string, FilaRepartidor>();
  for (const p of VENTAS) {
    if (p.canal !== "domicilio" || p.entregaMin === null || p.diaNegocio < RANGO_ACTUAL.desde) continue;
    const n = (hash(p.id) % 3) + 1;
    const k = `${p.propertyId}|${n}`;
    const a = m.get(k) ?? { propertyId: p.propertyId, repartidorId: `rep-${p.propertyId.slice(-2)}-${n}`, nombre: `Repartidor SINTÉTICO ${n}`, entregas: 0, minSuma: 0, tarde: 0, incidencias: 0 };
    m.set(k, { ...a, entregas: a.entregas + 1, minSuma: a.minSuma + p.entregaMin, tarde: a.tarde + (p.entregaMin > 50 ? 1 : 0), incidencias: a.incidencias + (hash(`${p.id}i`) % 41 === 0 ? 1 : 0) });
  }
  return [...m.values()].sort((a, b) => (a.repartidorId < b.repartidorId ? -1 : 1));
}

function escalaciones(): FilaEscalacionHora[] {
  const m = new Map<string, FilaEscalacionHora>();
  for (const p of D.pedidos) {
    if (p.diaNegocio < RANGO_ACTUAL.desde || p.diaNegocio > RANGO_ACTUAL.hasta) continue;
    const k = `${p.propertyId}|${dowIso(p.diaNegocio)}|${p.horaLocal}`;
    const a = m.get(k) ?? { propertyId: p.propertyId, dowNegocio: dowIso(p.diaNegocio), horaLocal: p.horaLocal, conversaciones: 0, handoffs: 0 };
    m.set(k, { ...a, conversaciones: a.conversaciones + 2, handoffs: a.handoffs + (hash(`${p.id}h`) % 9 === 0 ? 1 : 0) });
  }
  return [...m.values()];
}

// ---- Colonias SINTÉTICAS (k = 5: lo que no llega se agrupa en «(otras)») ---------------------------------------------------------------------

const COLONIAS = ["Colonia SINTÉTICA Norte", "Colonia SINTÉTICA Centro", "Colonia SINTÉTICA Jardines", "Colonia SINTÉTICA Poniente", "Colonia SINTÉTICA Sur", "Colonia SINTÉTICA Oriente"] as const;

function colonias(): FilaColonia[] {
  const m = new Map<string, FilaColonia & { cli: Set<string> }>();
  for (const p of VENTAS) {
    if (p.canal !== "domicilio" || p.diaNegocio < RANGO_ACTUAL.desde) continue;
    const cli = hash(p.clienteId);
    const nombre = cli % 11 === 0 ? `Colonia SINTÉTICA Rincón ${cli % 40}` : COLONIAS[cli % COLONIAS.length]!;
    const k = `${p.propertyId}|${nombre}`;
    const a = m.get(k) ?? { propertyId: p.propertyId, colonia: nombre, pedidos: 0, netaCentavos: 0, entregados: 0, minSuma: 0, clientes: 0, sucursalCercanaId: p.propertyId, distanciaKm: 1 + (cli % 70) / 10, cli: new Set<string>() };
    a.cli.add(p.clienteId);
    m.set(k, { ...a, pedidos: a.pedidos + 1, netaCentavos: a.netaCentavos + p.netaCentavos, entregados: a.entregados + (p.entregaMin === null ? 0 : 1), minSuma: a.minSuma + (p.entregaMin ?? 0), clientes: a.cli.size });
  }
  const filas = [...m.values()].map(({ cli: _cli, ...f }) => f);
  // k = 5: lo que tenga menos de 5 pedidos o 5 clientes se agrupa en «(otras)» (lo hace la base; aquí se reproduce para la fixture).
  const grandes = filas.filter((f) => f.pedidos >= 5 && f.clientes >= 5);
  const chicas = filas.filter((f) => !(f.pedidos >= 5 && f.clientes >= 5));
  const otras = new Map<string, FilaColonia>();
  for (const f of chicas) {
    const a = otras.get(f.propertyId) ?? { propertyId: f.propertyId, colonia: "(otras)", pedidos: 0, netaCentavos: 0, entregados: 0, minSuma: 0, clientes: 0, sucursalCercanaId: null, distanciaKm: null };
    otras.set(f.propertyId, { ...a, pedidos: a.pedidos + f.pedidos, netaCentavos: a.netaCentavos + f.netaCentavos, entregados: a.entregados + f.entregados, minSuma: a.minSuma + f.minSuma, clientes: a.clientes + f.clientes });
  }
  return [...grandes, ...otras.values()].sort((a, b) => (a.propertyId + a.colonia < b.propertyId + b.colonia ? -1 : 1));
}

// ---- Agotados y SoftRestaurant ------------------------------------------------------------------------------------------------------------

function agotados(): FilaAgotado[] {
  return D.agotados.map((a) => (a.propertyId === ID_T1 && a.productId === "p-flan" ? { ...a, disponible: false, agotadoHasta: null } : a));
}

/**
 * Resumen de SR de T2 (21–27 sep) derivado de `CSV_SR_SINTETICO`. Para ilustrar el semáforo del cuadre, el «domicilio» de SR de 3 días se alinea con el
 * domicilio del agente de esa sucursal (21 y 23: igual, verde; 22: +2 %, ámbar); los demás días quedan como los trae el archivo (rojo).
 */
function resumenSrSintetico(): FilaSrResumen[] {
  const n = normalizarExportSr({ tabla: parsearCsvSr(CSV_SR_SINTETICO), corte: "01:00", tipo: "cuentas" });
  if (!n.ok || n.tipo !== "cuentas") throw new Error("CSV_SR_SINTETICO no normaliza");
  const base = derivarResumenDeCuentas(ID_T2, n.renglones);
  const ajuste: Readonly<Record<string, number>> = { "2026-09-21": 1, "2026-09-22": 1.02, "2026-09-23": 1 };
  const nuestro = (d: string): { neta: number; pedidos: number } => {
    const l = VENTAS.filter((p) => p.propertyId === ID_T2 && p.canal === "domicilio" && p.diaNegocio === d);
    return { neta: l.reduce((a, p) => a + p.netaCentavos, 0), pedidos: l.length };
  };
  const resto = base.filter((f) => !(f.tipoServicio === "domicilio" && ajuste[f.diaNegocio] !== undefined));
  const alineadas = Object.entries(ajuste).map(([d, k]): FilaSrResumen => {
    const x = nuestro(d);
    const neta = Math.round(x.neta * k);
    return { propertyId: ID_T2, diaNegocio: d, tipoServicio: "domicilio", formaPago: null, tickets: x.pedidos, brutaCentavos: neta, descuentoCentavos: 0, canceladoCentavos: 0, propinaCentavos: 0, ivaCentavos: null, netaCentavos: neta };
  });
  return [...resto, ...alineadas].sort((a, b) => (a.diaNegocio + a.tipoServicio < b.diaNegocio + b.tipoServicio ? -1 : 1));
}

async function servicioPara(ids: readonly string[] | null, conSr: boolean, comandasModo: "sombra" | "apagado" = "sombra"): Promise<ServicioCfo> {
  const cobertura = IDS.map((id) => ({ propertyId: id, primerDia: "2026-05-01", ultimoDia: "2026-09-27", zona: "America/Merida", corte: "01:00:00" }));
  const percentiles = [
    ...IDS.map((id, i) => ({ propertyId: id, alcance: "sucursal" as const, entregados: 100, p50Min: 35, p90Min: 50 + i * 3 })),
    { propertyId: null, alcance: "conjunto" as const, entregados: 700, p50Min: 37, p90Min: 58 },
  ];
  const c = canasta();
  const todosCli = VENTAS;
  const repo = new InMemoryCfoRepository({
    sucursales: IDS,
    ahora: () => AHORA,
    dataset: {
      ventasDiarias: D.ventasDiarias, cortesias: D.cortesias, ventasHora: D.ventasHora, productos: D.productos, agenteDiario: D.agenteDiario,
      comandasPos: comandasModo === "apagado" ? D.comandasPos.map((f) => ({ ...f, modo: "apagado" })) : D.comandasPos,
      clientesResumen: D.clientes, agotados: agotados(), cobertura, entregasPercentiles: percentiles,
      clientesCohortes: [...SUC.flatMap((s) => cohortes(s.propertyId, todosCli.filter((p) => p.propertyId === s.propertyId))), ...cohortes(null, todosCli)],
      clientesAltas: [...SUC.flatMap((s) => altas(s.propertyId, todosCli.filter((p) => p.propertyId === s.propertyId))), ...altas(null, todosCli)],
      clientesSegmentoHora: [...SUC.flatMap((s) => segmentoHora(s.propertyId, todosCli.filter((p) => p.propertyId === s.propertyId))), ...segmentoHora(null, todosCli)],
      canastaPares: c.pares, canastaTotales: c.totales, canastaTickets: c.tickets,
      entregas: entregas(), repartidores: repartidores(), escalacionesHora: escalaciones(), colonias: colonias(),
      srResumen: conSr ? resumenSrSintetico() : [],
    },
  });
  for (const k of costosCapturadosSinteticos(MES)) await repo.costoGuardar({ organizationId: ORG_SINTETICA, propertyId: k.propertyId, mes: k.mes, concepto: k.concepto, montoCentavos: k.montoCentavos, pct: k.pct, nota: null });
  const propertyIds = ids ?? IDS;
  return new ServicioCfo({
    repo,
    organizationId: ORG_SINTETICA,
    alcance: { propertyIds, todas: ids === null, organizacionCompleta: true },
    propertyIdsSql: ids,
    sucursales: SUC.filter((s) => propertyIds.includes(s.propertyId)).map((s) => ({ propertyId: s.propertyId, nombre: s.nombre, slug: s.codigo.toLowerCase() })),
    ahora: AHORA,
  });
}

const consulta = (): ConsultaCfo => ({ ...RANGO_ACTUAL, comparar: "periodo_anterior", granularidad: "dia" });
const rotular = <T extends { readonly avisos: readonly string[] }>(v: T): T => ({ ...v, avisos: [AVISO_SINTETICO, ...v.avisos] });

export interface FixtureCfoB {
  readonly clientes: Record<string, unknown>;
  readonly productos: Record<string, unknown>;
  readonly patrones: Record<string, unknown>;
  readonly operacion: Record<string, unknown>;
  /** `<seleccion>|sinSr` y `<seleccion>|conSr` */
  readonly cuadre: Record<string, unknown>;
  /** Lotes y cobertura sin ningún reporte cargado (los lotes cargados los arma la API simulada al importar). */
  readonly lotesSinSr: unknown;
  /** Operación con el envío de comandas apagado (para los estados del bloque (a)). */
  readonly operacionApagada: unknown;
}

export async function construirFixtureCfoB(): Promise<FixtureCfoB> {
  const clientes: Record<string, unknown> = {};
  const productos: Record<string, unknown> = {};
  const patrones: Record<string, unknown> = {};
  const operacion: Record<string, unknown> = {};
  const cuadre: Record<string, unknown> = {};
  for (const [clave, ids] of Object.entries(SELECCIONES_B)) {
    clientes[clave] = rotular(await (await servicioPara(ids, false)).clientesVista(consulta()));
    productos[clave] = rotular(await (await servicioPara(ids, false)).productosVista(consulta()));
    patrones[clave] = rotular(await (await servicioPara(ids, false)).patronesVista(consulta()));
    operacion[clave] = rotular(await (await servicioPara(ids, false)).operacionVista(consulta()));
    cuadre[`${clave}|sinSr`] = rotular(await (await servicioPara(ids, false)).cuadreSr(consulta()));
    cuadre[`${clave}|conSr`] = rotular(await (await servicioPara(ids, true)).cuadreSr(consulta()));
  }
  return {
    clientes,
    productos,
    patrones,
    operacion,
    cuadre,
    lotesSinSr: await (await servicioPara(null, false)).lotesSr(20),
    operacionApagada: rotular(await (await servicioPara(null, false, "apagado")).operacionVista(consulta())),
  };
}
