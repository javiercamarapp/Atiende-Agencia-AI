# verify-env

Punto único de consulta en CLI de "qué credencial le falta a este entorno" —
compañero de `docs/CREDENCIALES.md` (la referencia en prosa) y de
`GET /superadmin/integraciones` (la misma consulta, pero en vivo desde el panel de
plataforma). Los tres reutilizan exactamente la misma función pura
(`computeIntegrationsStatus` en `apps/api/src/integrations-status.ts`) — nunca hay
dos listas de integraciones que puedan desalinearse.

## Qué hace

Lee el `process.env` actual del proceso, corre `computeIntegrationsStatus` /
`missingStartupVars`, e imprime una tabla: una fila por integración, si está
`configurada` y qué nombres de variable le faltan. **Nunca imprime un valor de
variable** — ni completo, ni truncado, ni su longitud.

## Código de salida

- `0` — siempre, salvo que falte alguna variable obligatoria para arrancar la API
  entera (`JWT_SECRET`, `VOICE_TOOL_SECRET`, `WHATSAPP_VERIFY_TOKEN`,
  `WHATSAPP_APP_SECRET`, `INTERNAL_SECRET`, `RENTAS_OWNER_JWT_SECRET`,
  `DATABASE_URL` — ver `STARTUP_REQUIRED_ENV_VARS` en `integrations-status.ts`).
- `1` — en ese caso.

Una integración de terceros sin configurar (Stripe, un PAC de CFDI, un proveedor
LLM, etc.) es un estado normal en desarrollo y **nunca** hace fallar este script —
mismo criterio "503 honesto, nunca un arranque roto" que ya usa el resto del
código real (ver `docs/CREDENCIALES.md`).

## Uso

```
npm run verify:env
```

o directamente:

```
node --experimental-strip-types scripts/verify-env/verify-env.ts
```

## Cómo se mantiene

Nunca agregues una integración o variable aquí — todo el catálogo vive en
`apps/api/src/integrations-status.ts` (`INTEGRATIONS`/`OPERATIONAL_ENV_VARS`).
`apps/api/tests/env-inventory-guard.spec.ts` falla en `npm run test:unit` si el
código empieza a leer una variable de entorno que ese catálogo no conoce todavía.
