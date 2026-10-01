// Punto de entrada: `node --experimental-strip-types e2e/mock-api/main.ts` (lo arranca playwright.config.ts).
// Variables: E2E_API_PORT (8788 por defecto), E2E_API_LATENCY_MS (0 por defecto).
import { iniciarServidor } from "./servidor.ts";

const puerto = Number(process.env.E2E_API_PORT ?? "8788");
const latenciaMs = Number(process.env.E2E_API_LATENCY_MS ?? "0");

const servidor = await iniciarServidor({ puerto, latenciaMs });
console.log(`[mock-api] escuchando en ${servidor.url} (solo loopback, sin base de datos ni secretos)`);

for (const senal of ["SIGINT", "SIGTERM"] as const) {
  process.on(senal, () => {
    void servidor.cerrar().then(() => process.exit(0));
  });
}
