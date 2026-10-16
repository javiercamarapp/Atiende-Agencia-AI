# verify-restaurantes-agente-preview-rate-limit

Clase de defecto: **función de SOLO sistema llamada con la sesión del staff**. El 8-oct-2026, «Configuración → Probar agente» del panel
respondía «Error interno» al primer mensaje: `restaurantes.consume_api_rate_limit` exige `auth.uid() is null` (lanza 42501 «es solo para la
sesión de sistema») y `agente-preview.ts` la llamaba dentro de `dbSession` (sesión del staff). Los tests con repositorio en memoria no lo
veían porque el repositorio no imita esa restricción.

El arreglo no toca SQL: los topes se consumen en una sesión de sistema propia (`withAppSession({ userId: null })`, commit propio), igual que
hacían ya `hoteles/voice-tools.ts` y `citas/voice-tools.ts`. El actor sigue siendo el staff autenticado del JWT y la organización de su
membership.

## Qué demuestra

- **Parte 1 (`assertions.sql`, 15 escenarios, es lo que corre el gate de CI):** el limitador rechaza al staff autenticado (42501, el mensaje
  exacto del registro de producción) y a `anon`; con la sesión de sistema funciona: tope por staff de «Probar agente» (40 en 10 min: el 41 se
  rechaza), tope por organización (400/día: el 401 se rechaza), aislamiento entre staff, scopes y organizaciones, ventana vencida, actor solo
  como sha256. Misma clase en citas («Probar conexión» de Cal.com/CalDAV): el limitador y la lectura del secreto del Vault rechazan al staff.
- **Parte 2 (`apps/api/tests/restaurantes-agente-preview-pg-real.spec.ts`):** la ruta HTTP real (JWT, `dbSession`, `requirePropertyMembership`)
  con el motor de producción y el repositorio de Postgres: el primer mensaje responde 200, el 41.º 429 sin invocar al agente, el 401.º de la
  organización 429 `agente_preview_tope`, y el preview de voz (sesión y herramienta) tampoco da 500. Sin el arreglo, esta parte falla con el
  500 «consume_api_rate_limit es solo para la sesión de sistema».
  Además cubre el relevo de herramientas del preview de voz (`POST .../admin/voz/preview/:sesionId/herramienta`): `historial_pedidos`,
  `repetir_pedido`, `cotizar_pedido`, `confirmar_resumen` y `crear_pedido` deben responder SIN `resultado.error` (sin el arreglo: «Error interno
  al ejecutar la herramienta» con 200, por `cliente_memoria` / `read_order_flow_state`, funciones de solo sistema), `crear_pedido` devuelve un
  pedido simulado `PRUEBA-xxxx` y NINGUNA tabla de `restaurantes`/`core` cambia salvo `order_flow_state` y `api_rate_limits` (se cuentan filas
  antes y después), el modo y la organización no salen del cuerpo, y la autorización ocurre antes de abrir la sesión de sistema.

## Cómo correrlo

```
scripts/verify-restaurantes-agente-preview-rate-limit/run.sh          # puerto aleatorio 56000-60999
VERIFY_PGPORT=57431 scripts/verify-restaurantes-agente-preview-rate-limit/run.sh
```

Requiere `initdb`/`pg_ctl`/`psql` en PATH. Nunca usa el puerto 5432. El gate de CI (`scripts/verify-real-postgres-ci/run-gate.mjs`) descubre
esta carpeta sola y corre solo la parte 1; la parte 2 corre en CI en el job `restaurantes-agente-preview-pg-real-gate` de
`.github/workflows/postgres-real-gate.yml` (Postgres efímero con `initdb`, como `whatsapp-concurrencia-gate`).
