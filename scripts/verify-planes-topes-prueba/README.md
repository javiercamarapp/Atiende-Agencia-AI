# verify-planes-topes-prueba

Postgres **real** (el gate de CI `scripts/verify-real-postgres-ci/run-gate.mjs` lo descubre solo): migración
`packages/db/migrations/0046_planes_topes_prueba_portal.sql` (espejo en `supabase/migrations/`).

Cubre el medidor mensual de mensajes (`core.message_usage_record`, `core.message_quota_check`), los avisos de fin de
prueba (`core.trial_notice_claim/_recipients/_mark`) y las dos lecturas (`core.message_usage_for_org`,
`core.superadmin_list_message_usage`):

- **Umbrales**: el mensaje 801 de 1000 cruza el 80 % una sola vez; el 1001 cruza el tope, se registra como excedente y el
  contador sigue; los mensajes repetidos (misma referencia) no cuentan dos veces.
- **Zona horaria**: un mensaje a las 23:30 de `America/Merida` del último día del mes cuenta en ESE mes (no en el siguiente, como
  haría un corte en UTC).
- **Bloqueo por plan**: solo con acción `pausar` y tope consumido se omiten los proactivos no críticos; lo transaccional y lo
  crítico siempre pasan.
- **Fin de prueba**: avisos a 7/3/1 días exactamente una vez, con el día calculado en la zona del negocio (23:30 en Mérida); los
  correos fallidos se reintentan hasta 3 veces y los entregados nunca se reclaman de nuevo.
- **Seguridad**: funciones de sistema rechazan a un usuario autenticado y a `anon`; lectura cross-tenant devuelve `NULL`;
  caller binding; superadmin-only; las tablas no son legibles directo.

Uso manual: `scripts/verify-planes-topes-prueba/run.sh` (requiere `initdb`, `pg_ctl` y `psql` en PATH).
