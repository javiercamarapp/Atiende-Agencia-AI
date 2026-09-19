// verify-env — imprime el estado real de cada integración externa a partir del
// env actual del proceso (mismo criterio honesto que el resto del repo: nunca
// imprime valores, solo nombres de variable y booleanos). Reutiliza la MISMA
// función pura que expone `GET /superadmin/integraciones`
// (apps/api/src/integrations-status.ts) — nunca dupliques la lista de
// integraciones/variables, actualiza solo ese archivo.
//
// Uso:
//   npm run verify:env
// o directamente:
//   node --experimental-strip-types scripts/verify-env/verify-env.ts
//
// Código de salida: `0` SIEMPRE, salvo que falte alguna variable OBLIGATORIA
// para arrancar la API (`STARTUP_REQUIRED_ENV_VARS` de integrations-status.ts —
// JWT_SECRET/VOICE_TOOL_SECRET/WHATSAPP_VERIFY_TOKEN/WHATSAPP_APP_SECRET/
// INTERNAL_SECRET/RENTAS_OWNER_JWT_SECRET/DATABASE_URL), en cuyo caso sale `1`.
// Una integración de TERCEROS sin configurar (Stripe, un PAC, un LLM, etc.) es
// esperado en un entorno de desarrollo y NUNCA hace fallar este script — mismo
// criterio "503 honesto, nunca un arranque roto" que ya usa todo el código real.
import { pathToFileURL } from "node:url";
import { computeIntegrationsStatus, missingStartupVars, type IntegrationStatus } from "../../apps/api/src/integrations-status.ts";

function formatRow(status: IntegrationStatus): string {
  const estado = status.configurada ? "OK" : "falta config";
  const faltantes = status.faltantes.length > 0 ? status.faltantes.join(", ") : "-";
  return `[${estado.padEnd(13)}] ${status.id.padEnd(28)} faltantes: ${faltantes}`;
}

export function printIntegrationsReport(env: Readonly<Record<string, string | undefined>>, log: (line: string) => void = console.log): { ok: boolean; missingStartup: string[] } {
  const statuses = computeIntegrationsStatus(env);
  const missingStartup = missingStartupVars(env);

  log("verify-env — estado de integraciones (nunca se imprime ningún valor de secreto)\n");
  for (const status of statuses) log(formatRow(status));

  log("");
  if (missingStartup.length > 0) {
    log(`FALTA(N) VARIABLE(S) OBLIGATORIA(S) PARA ARRANCAR LA API: ${missingStartup.join(", ")}`);
  } else {
    log("Todas las variables obligatorias para arrancar la API están configuradas.");
  }

  const configuradas = statuses.filter((s) => s.configurada).length;
  log(`\n${configuradas}/${statuses.length} integraciones configuradas en este entorno.`);

  return { ok: missingStartup.length === 0, missingStartup };
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(entry).href;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  const { ok } = printIntegrationsReport(process.env);
  process.exit(ok ? 0 : 1);
}
