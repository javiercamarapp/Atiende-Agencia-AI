// CLI manual del modo LLM real. Ver `real.ts` y README.md. NO se ejecuta en CI.
// Uso: OPENROUTER_API_KEY=... npm run evals:citas:real -w @atiende/domain-citas -- --model <id> --max-usd 1 [--casos A01,K02]
import { ejecutarSuiteReal, llamadorOpenRouter, opcionesRealDesdeArgs } from "./real.ts";

const opts = opcionesRealDesdeArgs(process.argv.slice(2));
const { llamar, gasto } = llamadorOpenRouter(opts);
const r = await ejecutarSuiteReal(opts, llamar, gasto);
for (const c of r.conversaciones) {
  console.log(`${c.resultado.ok ? "OK   " : "FALLA"} ${c.resultado.casoId} $${c.costoUsd.toFixed(4)} ${c.resultado.graders.filter((g) => !g.ok).map((g) => `${g.grader}: ${g.detalle}`).join(" | ")}`);
}
const m = r.metricas;
console.log(`aprobadas ${r.conversaciones.filter((c) => c.resultado.ok).length}/${m.conversaciones}`);
console.log(`precision de herramienta ${m.precisionHerramienta.aciertos}/${m.precisionHerramienta.total}`);
console.log(`inventados: horarios ${m.inventados.horarios}, cifras ${m.inventados.cifras}, escrituras con slot inventado ${m.inventados.escriturasConSlotInventado}`);
console.log(`costo total $${m.costoTotalUsd.toFixed(4)}; por conversacion $${m.costoPorConversacionUsd.toFixed(4)}${r.cortadoPorTope ? `; CORTADO por el tope; sin correr: ${r.noCorridos.join(",")}` : ""}`);
process.exit(r.conversaciones.every((c) => c.resultado.ok) && !r.cortadoPorTope ? 0 : 1);
