// Fixtures de la API SIMULADA de e2e para el CFO de restaurantes (`/v1/restaurantes/:id/admin/cfo/*`). Solo existen aquí: la API real
// (apps/api/.../restaurantes/cfo.ts) la prueban apps/api/tests y scripts/verify-restaurantes-cfo-* contra Postgres.
//
// Las respuestas son SINTÉTICAS: salen del generador de CFO-04 (PM, 7 sucursales, semilla fija) pasando por el servicio real de CFO-05, y se guardan en
// `restaurantes-cfo.datos.json` (apps/web/tests/restaurantes-cfo-fixture-sintetica.spec.ts falla si el JSON se desfasa del contrato). Cada vista lleva
// el aviso «SINTÉTICO» al frente. Cubre el rango 21–27 sep 2026 (y la semana anterior para la variación) y estas selecciones de sucursal:
// todas, solo Prolongación Montejo (T1), solo Pensiones (T3, que NO captura nómina a propósito), solo Galerías (T4) y T1 + Francisco de Montejo (T2). Cualquier otra combinación
// responde 404 honesto (`mock_sin_fixture_cfo`). La exportación (CFO-06) no existe aquí: responde 404 y el botón de la SPA se oculta.
import { readFileSync } from "node:fs";
import type { EstadoEscenario, Peticion, Ruta } from "../tipos.ts";
import { fallo } from "../respuestas.ts";

const A = "00000000-0000-4000-8000-0000000000";
const ID_T1 = `${A}a1`;
const ID_T2 = `${A}a2`;
const ID_T3 = `${A}a3`;
const ID_T4 = `${A}a4`;
const DESDE_ACTUAL = "2026-09-21";
const B = "/v1/restaurantes/:id/admin/cfo";

interface Datos {
  alcance: unknown;
  resumen: Record<string, unknown>;
  ventas: Record<string, unknown>;
  sucursales: Record<string, unknown>;
  estadoResultados: Record<string, unknown>;
  pedidos: PedidoMock[];
  config: { config: Record<string, number | null>; defaults: unknown; rangos: unknown; configurada: boolean; puedeGuardar: boolean; disponible: boolean };
}

interface PedidoMock {
  orderId: string;
  orderNumber: string;
  propertyId: string;
  diaNegocio: string;
  horaLocal: number;
  canal: string;
  source: string;
  status: string;
  paymentMethod: string | null;
  descCentavos: number;
  esCompensacion: boolean;
}

let cache: Datos | null = null;
function datos(): Datos {
  cache ??= JSON.parse(readFileSync(new URL("./restaurantes-cfo.datos.json", import.meta.url), "utf8")) as Datos;
  return cache;
}

interface EstadoCfo {
  nominaT3: boolean;
  config: Record<string, number | null> | null;
}
const estadoCfo = (estado: EstadoEscenario): EstadoCfo => estado.obtener<EstadoCfo>("rest.cfo", () => ({ nominaT3: false, config: null }));

/** `sucursales=` -> clave de selección que cubren las fixtures; null si no hay respuesta preparada para esa combinación. */
function seleccion(q: URLSearchParams): "todas" | "t1" | "t3" | "t4" | "t1t2" | null {
  const crudo = q.get("sucursales");
  if (!crudo || crudo === "todas") return "todas";
  const ids = [...new Set(crudo.split(",").map((x) => x.trim().toLowerCase()))].sort();
  if (ids.length === 1 && ids[0] === ID_T1) return "t1";
  if (ids.length === 1 && ids[0] === ID_T3) return "t3";
  if (ids.length === 1 && ids[0] === ID_T4) return "t4";
  if (ids.length === 2 && ids[0] === ID_T1 && ids[1] === ID_T2) return "t1t2";
  return null;
}

const sinFixtureCfo = () => fallo(404, "mock_sin_fixture_cfo: la API simulada del CFO solo tiene respuestas para 21–27 sep 2026 y las selecciones todas / Prolongación Montejo / Pensiones / Galerías / Montejo + Francisco de Montejo.");

function porSeleccion(tabla: Record<string, unknown>, p: Peticion, sufijo = ""): unknown {
  const sel = seleccion(p.query);
  const v = sel ? tabla[`${sel}${sufijo}`] : undefined;
  return v ?? sinFixtureCfo();
}

function filtroDe(p: Peticion): Record<string, string | number | boolean> {
  const crudo = p.query.get("filtro");
  if (!crudo) return {};
  try {
    return JSON.parse(crudo) as Record<string, string | number | boolean>;
  } catch {
    return {};
  }
}

const dowDe = (dia: string): number => ((new Date(`${dia}T00:00:00Z`).getUTCDay() + 6) % 7) + 1;

export const rutasRestaurantesCfo: readonly Ruta[] = [
  { metodo: "GET", patron: `${B}/alcance`, roles: ["owner", "admin"], manejador: () => datos().alcance },
  { metodo: "GET", patron: `${B}/resumen`, roles: ["owner", "admin"], manejador: (p) => porSeleccion(datos().resumen, p, "|impacto") },
  { metodo: "GET", patron: `${B}/ventas`, roles: ["owner", "admin"], manejador: (p) => porSeleccion(datos().ventas, p) },
  { metodo: "GET", patron: `${B}/sucursales`, roles: ["owner", "admin"], manejador: (p) => porSeleccion(datos().sucursales, p) },
  {
    metodo: "GET",
    patron: `${B}/estado-resultados`,
    roles: ["owner", "admin"],
    manejador: (p) => {
      const sel = seleccion(p.query);
      const desde = p.query.get("desde") ?? DESDE_ACTUAL;
      // La nómina capturada de Pensiones solo cambia la vista de Pensiones (las demás selecciones no tienen variante: sirven la original).
      const conNomina = estadoCfo(p.estado).nominaT3 && sel === "t3" ? 1 : 0;
      const v = sel ? datos().estadoResultados[`${sel}|${desde}|${conNomina}`] : undefined;
      return v ?? sinFixtureCfo();
    },
  },
  {
    metodo: "GET",
    patron: `${B}/pedidos`,
    roles: ["owner", "admin"],
    manejador: (p) => {
      const sel = seleccion(p.query);
      const base = sel ? (datos().sucursales[sel] as Record<string, unknown> | undefined) : undefined;
      if (!base) return sinFixtureCfo();
      const f = filtroDe(p);
      const ids = sel === "t1" ? [ID_T1] : sel === "t3" ? [ID_T3] : sel === "t4" ? [ID_T4] : sel === "t1t2" ? [ID_T1, ID_T2] : null;
      let filas = datos().pedidos.filter(
        (x) =>
          (ids === null || ids.includes(x.propertyId)) &&
          (f["canal"] === undefined || x.canal === f["canal"]) &&
          (f["source"] === undefined || x.source === f["source"]) &&
          (f["status"] === undefined || x.status === f["status"]) &&
          (f["payment_method"] === undefined || x.paymentMethod === f["payment_method"]) &&
          (f["es_compensacion"] === undefined || x.esCompensacion === f["es_compensacion"]) &&
          (f["con_descuento"] === undefined || x.descCentavos > 0 === f["con_descuento"]) &&
          (f["hora_local"] === undefined || x.horaLocal === f["hora_local"]) &&
          (f["dow_negocio"] === undefined || dowDe(x.diaNegocio) === f["dow_negocio"]),
      );
      filas = [...filas].sort((a, b) => (a.diaNegocio < b.diaNegocio ? 1 : a.diaNegocio > b.diaNegocio ? -1 : Number(b.orderNumber) - Number(a.orderNumber)));
      const cursor = p.query.get("cursor");
      if (cursor) {
        const [d, n] = cursor.split("|") as [string, string];
        filas = filas.filter((x) => x.diaNegocio < d || (x.diaNegocio === d && Number(x.orderNumber) < Number(n)));
      }
      const limite = Math.min(Number(p.query.get("limite") ?? "50") || 50, 100);
      const pagina = filas.slice(0, limite);
      const ultima = pagina[pagina.length - 1];
      const { alcance, sucursales, periodo, disponible, bloques, fuentes, avisos, avisoLegal } = base as Record<string, unknown>;
      return { alcance, sucursales, periodo, disponible, bloques, fuentes, avisos, avisoLegal, pedidos: pagina, cursor: filas.length > limite && ultima ? `${ultima.diaNegocio}|${ultima.orderNumber}` : null, limite };
    },
  },
  {
    metodo: "GET",
    patron: `${B}/config`,
    roles: ["owner", "admin"],
    manejador: (p) => {
      const c = datos().config;
      const guardada = estadoCfo(p.estado).config;
      return guardada ? { ...c, config: { ...c.config, ...guardada }, configurada: true } : c;
    },
  },
  {
    metodo: "PUT",
    patron: `${B}/config`,
    roles: ["owner", "admin"],
    manejador: (p) => {
      const e = estadoCfo(p.estado);
      e.config = { ...(e.config ?? {}), ...((p.cuerpo ?? {}) as Record<string, number | null>) };
      const c = datos().config;
      return { ...c, config: { ...c.config, ...e.config }, configurada: true };
    },
  },
  {
    metodo: "GET",
    patron: `${B}/costos/historial`,
    roles: ["owner", "admin"],
    manejador: (p) => {
      const capturada = estadoCfo(p.estado).nominaT3 && p.query.get("propertyId") === ID_T3 && p.query.get("concepto") === "nomina";
      return { disponible: true, historial: capturada ? [{ id: "ver-1", version: 1, montoCentavos: 25_000_000, pct: null, nota: "Capturado desde el CFO", creadoPor: null, creadoEn: "2026-09-28T15:00:00.000Z", vigente: true }] : [] };
    },
  },
  {
    metodo: "PUT",
    patron: `${B}/costos`,
    roles: ["owner", "admin"],
    manejador: (p) => {
      const cuerpo = (p.cuerpo ?? {}) as { costos?: Array<{ propertyId: string | null; concepto: string; montoCentavos: number | null; pct: number | null }> };
      const costos = cuerpo.costos ?? [];
      if (costos.length === 0) return { status: 422, cuerpo: { code: "validation_error", message: "costos debe traer de 1 a 50 renglones." } };
      if (costos.some((c) => (c.montoCentavos === null) === (c.pct === null))) return { status: 422, cuerpo: { code: "validation_error", message: "Mande exactamente uno de montoCentavos o pct." } };
      if (costos.some((c) => c.concepto === "nomina" && c.propertyId === ID_T3)) estadoCfo(p.estado).nominaT3 = true;
      return { guardados: costos.length, ids: costos.map((_, i) => `costo-${i + 1}`), disponible: true, costos: [], conceptos: [], sucursales: [], puedeCapturarOrganizacion: true };
    },
  },
];
