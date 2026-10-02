// Lectura de los archivos de datos del seed de PM (datos + herramientas/evals del agente; el prompt de voz ya no es un archivo: sale de perfil-pm.ts). Modulo SIN efectos ni
// punto de entrada: lo comparten seed-pm-demo.ts y seed-volumen.ts. Cuando el script se ejecuta empaquetado
// (`ejecutar.mjs`), `ATIENDE_SEED_DIR` apunta a esta carpeta porque `import.meta.url` ya no es la del codigo fuente.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { PmAgentFiles, PmSeedData } from "../../packages/domain-restaurantes/src/seed/pm-demo.ts";

const HERE = process.env.ATIENDE_SEED_DIR ?? path.dirname(fileURLToPath(import.meta.url));

export function loadSeedInputs(dataDir = path.join(HERE, "data")): { data: PmSeedData; agent: PmAgentFiles } {
  const data = JSON.parse(readFileSync(path.join(dataDir, "pm-seed-data.json"), "utf8")) as PmSeedData;
  const agent: PmAgentFiles = {
    tools: JSON.parse(readFileSync(path.join(dataDir, "agente", "tools.json"), "utf8")),
    evals: JSON.parse(readFileSync(path.join(dataDir, "agente", "evals.json"), "utf8")),
  };
  return { data, agent };
}
