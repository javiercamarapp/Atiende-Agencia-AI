// CLI manual de la prueba ciega de voz de hoteles. Ver `real.ts` para las variables de entorno y el tope de gasto.
//   --falso  corre con el proveedor falso (sin credenciales ni costo) y deja el reporte de referencia.
// Escribe el reporte JSON y markdown en `docs/evals/hoteles/` (o en la carpeta de `--dir=<ruta>`).
import { fileURLToPath } from "node:url";
import { ejecutarPruebaCiegaFalsa, ejecutarPruebaCiegaReal, opcionesRealVozDesdeEntorno, reporteDeCorridaReal } from "./real.ts";
import { escribirReporte } from "./reporte.ts";

const dirReporte = process.argv.find((a) => a.startsWith("--dir="))?.slice(6) || fileURLToPath(new URL("../../../../../docs/evals/hoteles/", import.meta.url));
const imprimir = (r: { resultados: readonly { ok: boolean; id: string; error?: string; graders: readonly { ok: boolean; grader: string; detalle?: string }[] }[] }): void => {
  for (const x of r.resultados) {
    const fallos = x.graders.filter((g) => !g.ok).map((g) => `${g.grader}: ${g.detalle}`).join(" | ");
    console.log(`${x.ok ? "OK   " : "FALLA"} ${x.id} ${x.error ?? fallos}`);
  }
};

if (process.argv.includes("--falso")) {
  const reporte = await ejecutarPruebaCiegaFalsa();
  imprimir(reporte);
  const rutas = escribirReporte(reporte, dirReporte);
  console.log(`aprobados ${reporte.aprobacion.global.aprobados}/${reporte.aprobacion.global.total} (proveedor falso); reporte: ${rutas.md}`);
  process.exit(reporte.aprobacion.global.aprobados === reporte.aprobacion.global.total ? 0 : 1);
}

const opts = opcionesRealVozDesdeEntorno();
const r = await ejecutarPruebaCiegaReal(opts);
imprimir(r);
const reporte = reporteDeCorridaReal(r, opts);
const rutas = escribirReporte(reporte, dirReporte);
console.log(`aprobados ${reporte.aprobacion.global.aprobados}/${reporte.aprobacion.global.total}; gasto estimado ~$${r.gastoUsdEstimado.toFixed(3)}${r.cortadoPorTope ? `; CORTADO por el tope; sin correr: ${r.noCorridos.join(",")}` : ""}; reporte: ${rutas.md}`);
process.exit(r.resultados.length > 0 && r.resultados.every((x) => x.ok) && !r.cortadoPorTope ? 0 : 1);
