// Fixtures de la API SIMULADA de e2e para las pestañas del CFO B (CFO-08): clientes, platillos, patrones, operación y SoftRestaurant
// (`/v1/restaurantes/:id/admin/cfo/{clientes,productos,patrones,operacion,softrestaurant/*}`). Solo existen aquí: la API real
// (apps/api/.../restaurantes/cfo.ts) la prueban apps/api/tests y scripts/verify-restaurantes-cfo-*.
//
// Las lecturas salen de `restaurantes-cfo-b.datos.json` (SINTÉTICO, generado con CFO-04 + CFO-05; el guard
// apps/web/tests/restaurantes-cfo-b-fixture-sintetica.spec.ts falla si se desfasa). Cubre el rango 21–27 sep 2026 y las selecciones «todas» y
// Prolongación Montejo (T1). La importación de SoftRestaurant es REAL del lado de la normalización (usa el normalizador de CFO-04) y con estado por
// prueba: la vista previa rechaza columnas personales como la API, la importación es idempotente por huella y, ya con un lote de Francisco de Montejo (T2),
// el cuadre responde con el reporte sintético cargado.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizarExportSr, renglonesSqlCuentas, renglonesSqlResumen } from "../../../../../packages/domain-restaurantes/src/cfo/sr-normalizar.ts";
import type { EstadoEscenario, Peticion, Ruta } from "../tipos.ts";
import { conStatus, fallo } from "../respuestas.ts";

const A = "00000000-0000-4000-8000-0000000000";
const ID_T1 = `${A}a1`;
const ID_T2 = `${A}a2`;
const B = "/v1/restaurantes/:id/admin/cfo";

interface DatosB {
  clientes: Record<string, unknown>;
  productos: Record<string, unknown>;
  patrones: Record<string, unknown>;
  operacion: Record<string, unknown>;
  cuadre: Record<string, unknown>;
  lotesSinSr: { disponible: boolean; lotes: unknown[]; cobertura: unknown[] };
  operacionApagada: unknown;
}

let cache: DatosB | null = null;
function datos(): DatosB {
  cache ??= JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "restaurantes-cfo-b.datos.json"), "utf8")) as DatosB;
  return cache;
}

interface Lote {
  id: string;
  propertyId: string;
  tipo: string;
  nombreArchivo: string;
  fechaMin: string | null;
  fechaMax: string | null;
  renglones: number;
  aceptados: number;
  rechazados: number;
  estado: "aplicado";
  origen: "archivo";
  creadoEn: string;
  dias: string[];
}
interface EstadoSr {
  lotes: Lote[];
  huellas: Record<string, { loteId: string; aceptados: number; rechazados: number }>;
}
const estadoSr = (e: EstadoEscenario): EstadoSr => e.obtener<EstadoSr>("rest.cfo.b.sr", () => ({ lotes: [], huellas: {} }));

function seleccion(q: URLSearchParams): "todas" | "t1" | null {
  const crudo = q.get("sucursales");
  if (!crudo || crudo === "todas") return "todas";
  const ids = [...new Set(crudo.split(",").map((x) => x.trim().toLowerCase()))];
  return ids.length === 1 && ids[0] === ID_T1 ? "t1" : null;
}

const sinFixtureCfoB = () => fallo(404, "mock_sin_fixture_cfo_b: la API simulada de las pestañas del CFO B solo tiene respuestas para 21–27 sep 2026 y las selecciones todas / Prolongación Montejo.");

function lectura(tabla: (d: DatosB) => Record<string, unknown>) {
  return (p: Peticion): unknown => {
    const sel = seleccion(p.query);
    return (sel ? tabla(datos())[sel] : undefined) ?? sinFixtureCfoB();
  };
}

// ---- Importación de SoftRestaurant ---------------------------------------------------------------------------------------------------------

interface CuerpoSr {
  propertyId: string;
  nombreArchivo: string;
  tabla: Array<Array<string | number | null>>;
  tipo?: "resumen_servicio" | "cuentas";
}

function leerCuerpo(c: unknown): CuerpoSr | ReturnType<typeof fallo> {
  const o = (c ?? {}) as Record<string, unknown>;
  if (typeof o["propertyId"] !== "string" || typeof o["nombreArchivo"] !== "string" || !Array.isArray(o["tabla"]) || o["tabla"].length < 1) {
    return fallo(422, "Se esperaba { propertyId, nombreArchivo, tabla }.");
  }
  return o as unknown as CuerpoSr;
}

function normalizar(cuerpo: CuerpoSr) {
  const n = normalizarExportSr({ tabla: cuerpo.tabla, corte: "01:00", ...(cuerpo.tipo ? { tipo: cuerpo.tipo } : {}) });
  if (n.ok) return { n } as const;
  if (n.motivo === "columnas_personales") {
    return { error: conStatus(422, { code: "columnas_personales", message: "El archivo trae columnas de datos personales; por privacidad no se importa. Quite esas columnas y vuelva a subirlo.", columnas: n.columnas, escribio: false }) } as const;
  }
  if (n.motivo === "demasiados_renglones") return { error: conStatus(413, { code: "payload_too_large", message: n.mensaje, maximo: n.maximo, recibidos: n.recibidos, escribio: false }) } as const;
  return {
    error: conStatus(422, { code: n.motivo, message: n.motivo === "sin_encabezado" ? "No se encontró la fila de encabezados del reporte de SoftRestaurant." : "Faltan columnas obligatorias en el archivo.", faltan: n.faltan, escribio: false }),
  } as const;
}

const huellaDe = (propertyId: string, tipo: string, renglones: unknown): string => createHash("sha256").update(JSON.stringify({ propertyId, tipo, renglones })).digest("hex");

export const rutasRestaurantesCfoB: readonly Ruta[] = [
  { metodo: "GET", patron: `${B}/clientes`, roles: ["owner", "admin"], manejador: lectura((d) => d.clientes) },
  { metodo: "GET", patron: `${B}/productos`, roles: ["owner", "admin"], manejador: lectura((d) => d.productos) },
  { metodo: "GET", patron: `${B}/patrones`, roles: ["owner", "admin"], manejador: lectura((d) => d.patrones) },
  { metodo: "GET", patron: `${B}/operacion`, roles: ["owner", "admin"], manejador: lectura((d) => d.operacion) },
  {
    metodo: "GET",
    patron: `${B}/softrestaurant/cuadre`,
    roles: ["owner", "admin"],
    manejador: (p) => {
      const sel = seleccion(p.query);
      const conSr = estadoSr(p.estado).lotes.some((l) => l.propertyId === ID_T2);
      return (sel ? datos().cuadre[`${sel}|${conSr ? "conSr" : "sinSr"}`] : undefined) ?? sinFixtureCfoB();
    },
  },
  {
    metodo: "GET",
    patron: `${B}/softrestaurant/lotes`,
    roles: ["owner", "admin"],
    manejador: (p) => {
      const e = estadoSr(p.estado);
      const base = datos().lotesSinSr;
      const porProp = new Map<string, Set<string>>();
      for (const l of e.lotes) porProp.set(l.propertyId, new Set([...(porProp.get(l.propertyId) ?? []), ...l.dias]));
      return {
        ...base,
        lotes: [...e.lotes].reverse().map(({ dias: _dias, ...l }) => l),
        cobertura: [...porProp.entries()].map(([propertyId, dias]) => {
          const orden = [...dias].sort();
          return { propertyId, diasConDato: orden.length, diaMin: orden[0] ?? null, diaMax: orden[orden.length - 1] ?? null, dias: orden };
        }),
      };
    },
  },
  {
    metodo: "POST",
    patron: `${B}/softrestaurant/importar/vista-previa`,
    roles: ["owner", "admin"],
    manejador: (p) => {
      const cuerpo = leerCuerpo(p.cuerpo);
      if ("status" in cuerpo) return cuerpo;
      const r = normalizar(cuerpo);
      if ("error" in r) return r.error;
      const { n } = r;
      const renglones = n.tipo === "cuentas" ? renglonesSqlCuentas(n.renglones) : renglonesSqlResumen(n.renglones);
      return {
        ok: true, tipo: n.tipo, inferido: true, avisoAlias: n.avisoAlias, mapeo: n.mapeo, ignoradas: n.ignoradas, advertencias: n.advertencias, aceptados: n.aceptados, rechazados: n.rechazados,
        omitidos: n.omitidos, errores: n.errores, fechaMin: n.fechaMin, fechaMax: n.fechaMax, muestra: renglones.slice(0, 10), huella: huellaDe(cuerpo.propertyId, n.tipo, renglones), escribio: false,
      };
    },
  },
  {
    metodo: "POST",
    patron: `${B}/softrestaurant/importar`,
    roles: ["owner", "admin"],
    manejador: (p) => {
      const cuerpo = leerCuerpo(p.cuerpo);
      if ("status" in cuerpo) return cuerpo;
      const r = normalizar(cuerpo);
      if ("error" in r) return r.error;
      const { n } = r;
      if (n.aceptados === 0) return conStatus(422, { code: "sin_renglones_validos", message: "Ningún renglón del archivo es válido; no se importó nada.", errores: n.errores, escribio: false });
      const renglones = n.tipo === "cuentas" ? renglonesSqlCuentas(n.renglones) : renglonesSqlResumen(n.renglones);
      const huella = huellaDe(cuerpo.propertyId, n.tipo, renglones);
      const e = estadoSr(p.estado);
      const previo = e.huellas[huella];
      const errores = n.errores.map((x) => ({ renglon: x.renglon, campo: x.campo, motivo: x.motivo }));
      if (previo) return conStatus(200, { loteId: previo.loteId, creado: false, aceptados: previo.aceptados, rechazados: previo.rechazados, errores: [], tipo: n.tipo, huella, inferido: true });
      const dias = [...new Set(n.renglones.map((x) => x.diaNegocio))];
      const lote: Lote = {
        id: `lote-sr-${e.lotes.length + 1}`, propertyId: cuerpo.propertyId, tipo: n.tipo, nombreArchivo: cuerpo.nombreArchivo, fechaMin: n.fechaMin, fechaMax: n.fechaMax, renglones: n.aceptados + n.rechazados,
        aceptados: n.aceptados, rechazados: n.rechazados, estado: "aplicado", origen: "archivo", creadoEn: "2026-09-28T15:00:00.000Z", dias,
      };
      e.lotes.push(lote);
      e.huellas[huella] = { loteId: lote.id, aceptados: n.aceptados, rechazados: n.rechazados };
      return conStatus(201, { loteId: lote.id, creado: true, aceptados: n.aceptados, rechazados: n.rechazados, errores, tipo: n.tipo, huella, inferido: true });
    },
  },
];

/** Para el guard de la fixture y las pruebas que necesitan el modo «apagado» del envío de comandas. */
export const operacionApagadaB = (): unknown => datos().operacionApagada;
