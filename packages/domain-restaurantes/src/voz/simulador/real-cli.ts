// CLI manual de la prueba ciega de voz contra Gemini real. Ver `real.ts` para las variables de entorno y el tope de gasto.
import { ejecutarPruebaCiegaReal, opcionesRealVozDesdeEntorno } from "./real.ts";

const r = await ejecutarPruebaCiegaReal(opcionesRealVozDesdeEntorno());
for (const x of r.resultados) {
  const fallos = x.graders.filter((g) => !g.ok).map((g) => `${g.grader}: ${g.detalle}`).join(" | ");
  console.log(`${x.ok ? "OK   " : "FALLA"} ${x.id} ${x.error ?? fallos}`);
}
console.log(`aprobados ${r.resultados.filter((x) => x.ok).length}/${r.resultados.length}; gasto estimado ~$${r.gastoUsdEstimado.toFixed(3)}${r.cortadoPorTope ? `; CORTADO por el tope; sin correr: ${r.noCorridos.join(",")}` : ""}`);
process.exit(r.resultados.length > 0 && r.resultados.every((x) => x.ok) && !r.cortadoPorTope ? 0 : 1);
