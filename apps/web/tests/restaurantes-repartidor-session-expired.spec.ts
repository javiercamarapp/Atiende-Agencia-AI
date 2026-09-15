// Ronda 13 — hallazgo de auditoría (severidad ALTA, "Repartidor.tsx es el ÚNICO
// consumidor autenticado de apps/web que no escucha SESSION_EXPIRED_EVENT"): cubre la
// función pura que decide si un `SESSION_EXPIRED_EVENT` recibido por
// `RepartidorPedidosPage` (pages/Repartidor.tsx) le corresponde a ESTA sesión
// (vertical "restaurantes") — la misma condición que ya usa el `useEffect` de
// RestaurantesShell.tsx, extraída a `isSessionExpiredEventForRepartidor`
// (../src/verticals/restaurantes/lib/repartidor-client.ts) para poder probarla sin
// DOM/React.
//
// Límite honesto de cobertura: este repo NO trae infraestructura de testing de
// componentes React (vitest.config.ts fija `environment: "node"`, sin jsdom ni
// happy-dom, y no hay `@testing-library/react` en package.json/apps/web/package.json
// — se verificó antes de escribir este archivo). Sin eso no se puede montar
// `RepartidorPedidosPage` de verdad, disparar un `CustomEvent` real en un `window` de
// prueba y verificar que `useNavigate()` navegó — el mismo límite que ya documentaron
// rondas anteriores para otras piezas de UI de este vertical. Lo que SÍ se prueba
// aquí es la lógica real que el listener de Repartidor.tsx ejecuta para decidir si
// reacciona (el `useEffect` en sí queda como código trivial de 6 líneas que llama a
// esta función + `clearSession`/`setSession`/`navigate`, ya cubiertos por separado:
// `clearSession` en auth-client.spec.ts, y `navigate` es react-router, no código de
// este repo).
import { describe, expect, it } from "vitest";
import { isSessionExpiredEventForRepartidor } from "../src/verticals/restaurantes/lib/repartidor-client.ts";
import type { SessionExpiredEventDetail } from "../src/lib/authed-fetch.ts";

describe("isSessionExpiredEventForRepartidor (Repartidor.tsx)", () => {
  it("vertical 'restaurantes' -> true (el repartidor SÍ debe reaccionar)", () => {
    const detail: SessionExpiredEventDetail = { vertical: "restaurantes" };
    expect(isSessionExpiredEventForRepartidor(detail)).toBe(true);
  });

  it("otra vertical abierta en otra pestaña (ej. 'hoteles') -> false, no debe desloguear al repartidor", () => {
    const detail: SessionExpiredEventDetail = { vertical: "hoteles" };
    expect(isSessionExpiredEventForRepartidor(detail)).toBe(false);
  });

  it("detail undefined (evento mal formado) -> false, nunca truena ni desloguea a ciegas", () => {
    expect(isSessionExpiredEventForRepartidor(undefined)).toBe(false);
  });
});
