// CLI manual del modo LLM real. Ver `real.ts` para las variables de entorno y el tope de gasto.
import { ejecutarSuiteReal, opcionesRealDesdeEntorno } from "./real.ts";

const resultado = await ejecutarSuiteReal(opcionesRealDesdeEntorno());
for (const r of resultado.resultados) {
  console.log(`${r.ok ? "OK " : "FALLA"} ${r.casoId} ${r.graders.filter((g) => !g.ok).map((g) => `${g.grader}: ${g.detalle}`).join(" | ")}`);
}
console.log(`aprobados ${resultado.resultados.filter((r) => r.ok).length}/${resultado.resultados.length}; gasto ~$${resultado.gastoUsd.toFixed(3)}${resultado.cortadoPorTope ? `; CORTADO por el tope; sin correr: ${resultado.noCorridos.join(",")}` : ""}`);
process.exit(resultado.resultados.every((r) => r.ok) && !resultado.cortadoPorTope ? 0 : 1);
