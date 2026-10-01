# Superadmin: zona CFO segura (SA-41)

Rol `finanzas` de solo lectura, MFA/step-up para entrar, bitacora de cada consulta financiera y exportaciones con step-up.
Codigo: `packages/db/migrations/0034_superadmin_zona_cfo.sql` (espejo `supabase/migrations/20240101000234_...`),
`apps/api/src/superadmin-seguridad/zona-cfo.ts`, `apps/api/src/routes/superadmin-zona-cfo.ts`,
`apps/web/src/superadmin/pages/ZonaCfo.tsx`. Verificacion SQL: `scripts/verify-superadmin-zona-cfo/`.

## Modelo

- **Rol `finanzas`** = un superadmin con fila en `core.cfo_zone_role`. Sigue siendo superadmin de plataforma (necesita serlo para
  enrolar su MFA, ver `0025`), pero queda **restringido**: solo lectura de las pantallas financieras.
- Quien tiene el rol lo asigna o retira OTRO superadmin completo (`PUT /superadmin/zona-cfo/roles/:userId`, motivo >= 20 caracteres,
  step-up). Nadie se asigna ni se quita el rol a si mismo; un restringido no puede asignar roles.

## Que hace cada capa

| Capa | Regla |
| --- | --- |
| API, corte por rol (`zona-cfo.ts`) | El rol `finanzas` solo pasa por `RUTAS_FINANCIERAS` marcadas `finanzas` y por las rutas de autoservicio de MFA/estado. Todo lo demas: 403 `rol_finanzas_solo_lectura` y queda un `denegado`. Lista blanca: una ruta nueva nace cerrada para `finanzas`. |
| API, step-up | `finanzas`: obligatorio en cada lectura, sin degradar (sin factor activo 403 `mfa_enrollment_required`; sin repositorio MFA o `0025` sin aplicar 503). Superadmin completo: la politica existente (con factor activo, token vigente; `SUPERADMIN_MFA_REQUIRED=1` la vuelve obligatoria). Exportar el P&L en CSV, leer la bitacora y asignar roles estan ademas en `SENSITIVE_ROUTES`. |
| API, bitacora | Cada lectura de `RUTAS_FINANCIERAS` se registra ANTES de ejecutarse, en una transaccion propia ya confirmada: actor, rol, accion (`consulta`/`exportacion`/`denegado`), recurso y filtros (solo parametros de consulta saneados). Si el registro falla (distinto de migracion pendiente), la consulta NO corre (503). |
| SQL, guard de escritura | `core.superadmin_require_caller` (redefinido) rechaza con 42501 a un superadmin restringido: ninguna escritura creada desde `0025` (MFA reset, interruptores, organizaciones, tipo de cambio, planes, infra del P&L, asignacion de roles) le es ejecutable ni por RPC directo. |
| SQL, bitacora | `core.cfo_access_log` append-only (trigger 0A000), RLS sin policy, sin GRANT; solo se escribe con `core.cfo_zone_log_access` (exige rol resuelto) y `core.cfo_zone_set_role`. Solo un superadmin completo la lee. |

## Alcance honesto

- Las funciones de escritura anteriores a `0025` (prospectos, impersonacion, break-glass) validan `core.is_platform_superadmin` y no pasan
  por `superadmin_require_caller`: para esas el corte al rol `finanzas` lo hace solo la capa de la API.
- Las lecturas del rol `finanzas` usan las funciones `*_for_superadmin` existentes (que aceptan a cualquier superadmin); la restriccion de
  que solo lea lo financiero es de la API.
- La bitacora registra lecturas que el API deja pasar; no cubre accesos directos a la base con credenciales de servicio.
- Los filtros guardan valores de parametros de consulta (truncados a 120 caracteres, hasta 20, sin claves con forma de secreto).

## Base sin migrar y orden de despliegue

Sin `0034` aplicada (o sin `cfoZoneRepo`): no hay rol restringido (nadie puede tenerlo) ni bitacora, y el comportamiento es el
anterior; `GET /superadmin/zona-cfo/estado|bitacora|roles` responden `disponible: false` y la asignacion 503. Orden: aplicar `0034`
(CUALQUIER orden respecto al codigo); desde ese momento cada consulta financiera queda registrada y el rol puede asignarse.
Con la MFA activa, las pantallas financieras piden el codigo (ya usan `fetchConStepUp`).
