-- Gemelo concurrente de packages/db/migrations/0100_indices_tablas_grandes.sql (Ola 4, G2).
--
-- Se corre en producción ANTES de `supabase db push`, con autocommit y sin -1/--single-transaction:
--   psql "$URL_DE_LA_BASE" -v ON_ERROR_STOP=1 -f scripts/indices-concurrentes/0100_indices_tablas_grandes.sql
-- `create index concurrently` no bloquea INSERT/UPDATE mientras construye, pero no puede correr dentro de una
-- transacción. Idempotente (`if not exists`): se puede repetir. Si una sentencia se interrumpe, el índice queda
-- INVALID: `drop index concurrently if exists <esquema>.<nombre>;` y vuelve a correr este archivo (la migración
-- 0100 se niega a avanzar mientras quede uno INVALID).
-- lock_timeout: la fase inicial y final de un build concurrente todavía espera locks breves; si la tabla está
-- tomada por una operación larga, mejor fallar en 5 s y reintentar que formarse delante de todas las escrituras.

set lock_timeout = '5s';

create index concurrently if not exists messaging_outbox_email_reintento_idx
  on citas.messaging_outbox (channel, next_attempt_at)
  where status in ('pending', 'failed');

create index concurrently if not exists messaging_outbox_email_reintento_idx
  on despachos.messaging_outbox (channel, next_attempt_at)
  where status in ('pending', 'failed');

create index concurrently if not exists messaging_outbox_email_reintento_idx
  on hoteles.messaging_outbox (channel, next_attempt_at)
  where status in ('pending', 'failed');

create index concurrently if not exists messaging_outbox_email_reintento_idx
  on licitaciones.messaging_outbox (channel, next_attempt_at)
  where status in ('pending', 'failed');

create index concurrently if not exists messaging_outbox_email_reintento_idx
  on rentas.messaging_outbox (channel, next_attempt_at)
  where status in ('pending', 'failed');

create index concurrently if not exists messaging_outbox_email_reintento_idx
  on restaurantes.messaging_outbox (channel, next_attempt_at)
  where status in ('pending', 'failed');

create index concurrently if not exists mensaje_conversacion_creado_idx
  on rentas.mensaje (conversacion_id, creado_en);

create index concurrently if not exists authz_audit_log_org_denegado_idx
  on core.authz_audit_log (organization_id, occurred_at desc)
  where decision = 'denied';
