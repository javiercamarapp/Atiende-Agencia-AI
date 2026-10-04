// CLI manual del modo LLM real. Ver `real.ts` para las variables de entorno y el tope de gasto.
import { ejecutarSuiteReal, opcionesRealDesdeEntorno } from "./real.ts";

const opciones = opcionesRealDesdeEntorno();
const resultado = await ejecutarSuiteReal(opciones);
for (const r of resultado.resultados) {
  console.log(`${r.ok ? "OK " : "FALLA"} ${r.casoId} ${r.graders.filter((g) => !g.ok).map((g) => `${g.grader}: ${g.detalle}`).join(" | ")}`);
  // PM_EVALS_TRAZA=1: conversacion y llamadas a herramientas de los casos que fallan (diagnostico; nunca imprime la llave).
  if (!r.ok && opciones.traza) {
    for (const e of r.eventos ?? []) {
      if (e.tipo === "herramienta") console.log(`    [tool] ${e.nombre} ${JSON.stringify(e.args)} -> ${JSON.stringify(e.resultado).slice(0, 300)}`);
      else console.log(`    [${e.tipo}] ${e.texto.replace(/\n/g, " / ")}`);
    }
  }
}
console.log(`aprobados ${resultado.resultados.filter((r) => r.ok).length}/${resultado.resultados.length}; gasto ~$${resultado.gastoUsd.toFixed(3)}${resultado.cortadoPorTope ? `; CORTADO por el tope; sin correr: ${resultado.noCorridos.join(",")}` : ""}`);
process.exit(resultado.resultados.every((r) => r.ok) && !resultado.cortadoPorTope ? 0 : 1);
