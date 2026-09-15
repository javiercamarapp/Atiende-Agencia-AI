// Setup global de Vitest (ver vitest.config.ts::test.setupFiles) — hallazgo de
// auditoría (rubro 2, autenticación y sesión, severidad ALTA: "sin rate-limit en
// /auth/login, /auth/refresh, accept-invite"). `@atiende/core-ratelimit::rateLimit()`
// (la API simple que ahora usa `apps/api/src/routes/auth.ts`) mantiene un limitador
// POR-PROCESO (ver su README, sección "API simple") — el mismo proceso de Vitest que
// corre TODA la suite de `apps/api/tests`.
//
// Varios fixtures reales de esa suite (`despachos-fixtures.ts`, `hoteles-fixtures.ts`,
// `citas-fixtures.ts`, `rentas-fixtures.ts`, `licitaciones-fixtures.ts`,
// `restaurantes-admin-kpis-fixtures.ts`) inician sesión contra `POST /auth/login` con
// emails de prueba FIJOS (ej. `admin@despacho-de-prueba.mx`) decenas de veces a lo
// largo de la suite completa, dentro del MISMO proceso — sin este reset, esos logins
// de fixture (nunca un intento real de fuerza bruta) chocarían contra el límite real y
// empezarían a devolver 429 en tests que no tienen nada que ver con rate-limiting.
//
// Se limpia el backend en memoria del limitador por-proceso ANTES de cada test
// individual, para que cada uno arranque con el contador en cero — mismo criterio de
// aislamiento que ya aplica cada test al construir su propio `InMemoryCoreRepository`/
// `InMemoryTenancyEngine` nuevo. Nunca se sustituye el rate limiter real por un mock:
// esto solo resetea su estado, el código de producción bajo prueba (`auth.ts`) sigue
// llamando a la función real.
import { beforeEach } from "vitest";
import { resetDefaultRateLimiterForTests } from "@atiende/core-ratelimit";

beforeEach(() => {
  resetDefaultRateLimiterForTests();
});
