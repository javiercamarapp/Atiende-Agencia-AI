-- 0100_indices_tablas_grandes.sql — Ola 4 (G2): índices que faltaban en tablas grandes, sin bloquear escrituras.
--
-- Por qué estos índices (cada uno resuelve una consulta real que hoy hace seq scan):
--   * <vertical>.messaging_outbox (6 verticales): `claim_email_outbox_batch` (0031) filtra
--     `channel = 'email' and status in ('pending','failed') and next_attempt_at <= now()`. El único índice
--     de reclamo, `messaging_outbox_claim_idx`, es PARCIAL `where status in ('pending','processing')`: su
--     predicado no implica el de la consulta (falta 'failed'), así que el planificador no puede usarlo y cada
--     corrida del cron de correo recorre la tabla completa (que crece con cada mensaje enviado). Índice parcial
--     nuevo con el MISMO predicado de la consulta: solo contiene filas por despachar, se mantiene chico.
--   * rentas.mensaje: el historial de una conversación (`where conversacion_id = $1 order by creado_en`,
--     domain-rentas/src/mensajeria/postgres-repository.ts) usaba el índice de una sola columna + sort. El
--     compuesto lo resuelve con un index scan ordenado. Se conserva `mensaje_conversacion_idx` (su borrado es
--     un paso aparte, ver docs/runbooks/TABLAS-GRANDES.md).
--   * core.authz_audit_log: la ficha de organización del superadmin (0052) cuenta accesos DENEGADOS de una
--     organización en una ventana (`organization_id = $1 and decision = 'denied' and occurred_at >= ...`); el
--     único índice es por `occurred_at` global. Parcial a 'denied' (la inmensa mayoría de filas son 'allowed').
--
-- Cómo se aplica SIN bloquear escrituras (ver scripts/verify-indices-tablas-grandes/check-indices-tablas-grandes.ts):
--   1. ANTES de esta migración, en producción: `psql "$URL" -f scripts/indices-concurrentes/0100_indices_tablas_grandes.sql`
--      (autocommit; `create index concurrently` no puede ir dentro de una transacción).
--   2. Esta migración (`supabase db push`): con los índices ya creados es un no-op. En una base chica (CI, local,
--      un proyecto nuevo) los crea aquí mismo.
--   `lock_timeout`: si alguna sentencia tuviera que esperar un lock (p. ej. el script no se corrió y una tabla
--   está ocupada), falla en 5 s en vez de quedar formada delante de todas las escrituras. Se restablece al final.
--   Guarda de INVALID: si un build concurrente se interrumpió, deja un índice INVALID con el nombre ocupado y
--   `if not exists` lo daría por bueno; aquí se aborta con un mensaje que indica borrarlo y repetir el paso 1.
--
-- Seguridad: solo índices. No hay GRANT, policy ni función persistente nueva (el bloque `do` es anónimo), así que
-- no cambia quién puede leer o escribir nada. Rollback: `drop index concurrently if exists <nombre>` por índice.
-- Compatibilidad: ningún código depende de que existan; con o sin ellos las consultas devuelven lo mismo.

set lock_timeout = '5s';

do $$
declare v_invalido text;
begin
  select string_agg(n.nspname || '.' || c.relname, ', ') into v_invalido
  from pg_index x
  join pg_class c on c.oid = x.indexrelid
  join pg_namespace n on n.oid = c.relnamespace
  where not x.indisvalid
    and (n.nspname, c.relname) in (
      ('citas', 'messaging_outbox_email_reintento_idx'), ('despachos', 'messaging_outbox_email_reintento_idx'),
      ('hoteles', 'messaging_outbox_email_reintento_idx'), ('licitaciones', 'messaging_outbox_email_reintento_idx'),
      ('rentas', 'messaging_outbox_email_reintento_idx'), ('restaurantes', 'messaging_outbox_email_reintento_idx'),
      ('rentas', 'mensaje_conversacion_creado_idx'), ('core', 'authz_audit_log_org_denegado_idx'));
  if v_invalido is not null then
    raise exception 'índice inválido (build concurrente interrumpido): %. Bórralo con drop index concurrently y repite scripts/indices-concurrentes/0100_indices_tablas_grandes.sql', v_invalido;
  end if;
end $$;

create index if not exists messaging_outbox_email_reintento_idx
  on citas.messaging_outbox (channel, next_attempt_at)
  where status in ('pending', 'failed');

create index if not exists messaging_outbox_email_reintento_idx
  on despachos.messaging_outbox (channel, next_attempt_at)
  where status in ('pending', 'failed');

create index if not exists messaging_outbox_email_reintento_idx
  on hoteles.messaging_outbox (channel, next_attempt_at)
  where status in ('pending', 'failed');

create index if not exists messaging_outbox_email_reintento_idx
  on licitaciones.messaging_outbox (channel, next_attempt_at)
  where status in ('pending', 'failed');

create index if not exists messaging_outbox_email_reintento_idx
  on rentas.messaging_outbox (channel, next_attempt_at)
  where status in ('pending', 'failed');

create index if not exists messaging_outbox_email_reintento_idx
  on restaurantes.messaging_outbox (channel, next_attempt_at)
  where status in ('pending', 'failed');

create index if not exists mensaje_conversacion_creado_idx
  on rentas.mensaje (conversacion_id, creado_en);

create index if not exists authz_audit_log_org_denegado_idx
  on core.authz_audit_log (organization_id, occurred_at desc)
  where decision = 'denied';

reset lock_timeout;
