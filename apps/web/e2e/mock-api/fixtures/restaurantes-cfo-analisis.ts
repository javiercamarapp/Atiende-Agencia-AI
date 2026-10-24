// Fixture de la API SIMULADA (e2e y pruebas de componente) de `GET /v1/restaurantes/:id/admin/cfo/analisis-clientes`. Solo existe aquí: la API real
// (apps/api/.../restaurantes/cfo.ts) la prueban apps/api/tests y scripts/verify-restaurantes-cfo-analisis-clientes contra Postgres.
//
// Las respuestas son SINTÉTICAS: salen del servicio real de CFO-05 sobre el repositorio en memoria (ver apps/web/tests/test-utils/cfo-fixture-analisis.ts) y se
// guardan en `restaurantes-cfo-analisis.datos.json`; el guard apps/web/tests/restaurantes-cfo-analisis-fixture-sintetica.spec.ts falla si se desfasa.
// Cubre el rango 21–27 sep 2026 (cualquier selección de sucursales recibe la misma respuesta). `?mock=sin095` simula una base sin la migración 095 y
// `?mock=vacio` un negocio sin ventas con cliente. Cualquier otro rango responde 404 honesto (`mock_sin_fixture_cfo_analisis`).
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Ruta } from "../tipos.ts";
import { fallo } from "../respuestas.ts";

const B = "/v1/restaurantes/:id/admin/cfo";
const FECHA = /^\d{4}-\d{2}-\d{2}$/;

interface VistaMock {
  secciones: { reactivacion: { datos: { filas: unknown[]; mostrados: number; limite: number } | null } };
}
type Datos = Record<"normal" | "sin095" | "vacio", VistaMock>;

let cache: Datos | null = null;
function datos(): Datos {
  cache ??= JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "restaurantes-cfo-analisis.datos.json"), "utf8")) as Datos;
  return cache;
}

export const rutasRestaurantesCfoAnalisis: readonly Ruta[] = [
  {
    metodo: "GET",
    patron: `${B}/analisis-clientes`,
    roles: ["owner", "admin"],
    manejador: (p) => {
      const desde = p.query.get("desde") ?? "";
      const hasta = p.query.get("hasta") ?? "";
      if (!FECHA.test(desde) || !FECHA.test(hasta) || desde > hasta) return fallo(422, "desde y hasta son obligatorios (YYYY-MM-DD).");
      const limiteRaw = p.query.get("limite") ?? "50";
      if (!/^\d{1,3}$/.test(limiteRaw) || Number(limiteRaw) < 1 || Number(limiteRaw) > 200) return fallo(422, "limite debe ser un entero entre 1 y 200.");
      if (desde !== "2026-09-21" || hasta !== "2026-09-27") return fallo(404, "mock_sin_fixture_cfo_analisis: la API simulada del análisis de clientes solo tiene respuestas para 21–27 sep 2026.");
      const modo = p.query.get("mock");
      const v = structuredClone(datos()[modo === "sin095" ? "sin095" : modo === "vacio" ? "vacio" : "normal"]);
      const r = v.secciones.reactivacion.datos;
      if (r) {
        r.filas = r.filas.slice(0, Number(limiteRaw));
        r.mostrados = r.filas.length;
        r.limite = Number(limiteRaw);
      }
      return v;
    },
  },
];
