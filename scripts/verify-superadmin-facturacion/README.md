# verify-superadmin-facturacion

Verificación, contra un Postgres **real**, de las 3 funciones nuevas de
`packages/db/migrations/0013_superadmin_facturacion.sql` (pantalla
`/superadmin/facturacion`, lectura agregada de la suscripción SaaS propia de
Atiende por organización + diagnóstico de webhook):

| Función | Qué expone |
|---|---|
| `core.list_organization_billing_for_superadmin` | Una fila por organización (join `organization`+`organization_billing`+conteo real de `membership`+`billing_entity_order`) — estado, asientos contratados, staff real, precio/customer/subscription de Stripe, último evento aplicado. |
| `core.list_recent_billing_webhook_events_for_superadmin` | Últimos N eventos de `billing_webhook_event` ya procesados (feed de plataforma, ver el límite honesto documentado en la migración). |
| `core.count_billing_webhook_events_for_superadmin` | Conteo total de esos mismos eventos. |

Las 3 siguen el MISMO patrón que el resto del back office de plataforma (ver
`scripts/verify-superadmin-caller-binding/` y
`scripts/verify-caller-binding-fase2/`): `security definer`, `p_caller_id`
explícito atado a `auth.uid() is not null and auth.uid() = p_caller_id`, más
`core.is_platform_superadmin(p_caller_id)` — nunca solo el segundo chequeo a
secas (ese fue exactamente el hallazgo que las dos verificaciones anteriores
cerraron para el resto del back office).

## Qué demuestra

12 escenarios (ver `assertions.sql` para el detalle exacto), 4 por función:

1. El superadmin real, con **su propia sesión** (`auth.uid()` = su propio id),
   ve los datos reales (seats=7 de la organización sembrada, el evento de
   webhook sembrado, el total real).
2. Un staff **normal y autenticado** (con `auth.uid()` real, pero sin ser
   superadmin) que pasa el UUID de un superadmin como `p_caller_id` obtiene
   CERO filas / el número real NUNCA se filtra — nunca un error que
   confirme/niegue si hay datos, mismo criterio que el resto del back office
   de lectura (`list_all_organizations_for_superadmin`/etc.).
3. Una sesión de **SISTEMA** (`auth.uid()` NULL) que pasa el UUID de un
   superadmin como `p_caller_id` — el patrón que `apps/api` usaría si
   `ProductionCoreRepository` olvidara abrir la sesión como el caller en vez
   de como sistema — también es rechazada (cero filas/cero).
4. `anon` no puede ni ejecutar ninguna de las 3 (sin `GRANT EXECUTE`).

## Por qué esto importa

`core.organization_billing` guarda `stripe_customer_id`/`stripe_subscription_id`/
`seats`/`status` reales de CADA organización cliente de Atiende — sin la
atadura a `auth.uid()`, cualquier `authenticated` (staff de CUALQUIER
organización) podría haber llamado `list_organization_billing_for_superadmin`
por RPC directo pasando el UUID de un superadmin real (no es un secreto
fuerte — aparece en filas de auditoría/membresías) y leído esa información de
TODAS las organizaciones de la plataforma, no solo la propia.

## Cómo correrlo

```
scripts/verify-superadmin-facturacion/run.sh
```

Requiere `initdb`/`pg_ctl`/`psql` en PATH (Postgres local, p. ej.
`brew install postgresql`). Si faltan, falla explícito en vez de fingir que
corrió algo — no bloquea `npm test`.

`scripts/verify-real-postgres-ci/run-gate.mjs` descubre este directorio
automáticamente (cualquier `scripts/verify-*/` con
`bootstrap.sql`+`post-migrations.sql`+`assertions.sql`) y lo corre en CI
contra el servicio `postgres:` de GitHub Actions — sin intervención manual.
