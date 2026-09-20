-- f2-orden-total-bitacoras -- mismo desempate estable y monótono que
-- packages/domain-rentas/migrations/022_rentas_audit_log_orden_determinista.sql
-- (PR #173) y packages/domain-despachos/migrations/011_despachos_audit_log_
-- orden_total_lectura_paginada.sql para `hoteles.fraude_audit_log`
-- (017_fraude_audit_log.sql).
--
-- A DIFERENCIA de rentas.audit_log en el momento de PR #173: `hoteles.
-- fraude_audit_log` hoy NO tiene ningún consumidor de lectura paginada -- se
-- buscó explícitamente (`grep -rn "fraude_audit_log" apps/ packages/`) y el único
-- código que la toca es la escritura (`hoteles.record_fraude_audit_log`, vía
-- `ProductionHotelesFraudeAuditSink`, sesión de sistema) y la policy de `select`
-- para staff con acceso a la property, sin ningún caller real todavía (ver el
-- comentario de cierre de la propia 017: "Ninguna ruta HTTP la expone todavía").
-- Esta migración NO corrige un bug activo en producción -- deja lista la
-- infraestructura de orden TOTAL (misma causa raíz que rentas: `now()` es
-- constante dentro de una transacción) para que el `listFraudeAuditLogPage` que
-- este mismo PR agrega a `HotelesRepository` nazca con orden determinista.
--
-- Misma columna, mismo tipo, mismo criterio EXACTO que 022 de rentas / 011 de
-- despachos -- ver esos archivos para el análisis completo verificado a mano
-- contra Postgres real.
--
-- COMPATIBILIDAD CON LA BASE SIN MIGRAR: `hoteles.fraude_audit_log` (017) ya vive
-- en producción desde hace muchas migraciones (posición ~96 de 164 en
-- supabase/migrations/ al momento de escribir esto, muy por detrás del corte de
-- "~30 migraciones atrás" que describe el estado real de la base) -- no hace
-- falta ningún fallback para "la tabla no existe todavía". El ÚNICO caso nuevo es
-- "017 aplicada, 028 (esta) no" -- `seq` no existe todavía y `order by ..., seq
-- desc` lanzaría 42703 (undefined_column). `PostgresHotelesRepository.
-- listFraudeAuditLogPage` cae al `order by created_at desc` de antes de esta
-- migración vía `runWithSavepointFallback` (`@atiende/db`), nunca revienta ni
-- revierte el resto de la transacción compartida del request.
alter table hoteles.fraude_audit_log add column seq bigint generated always as identity;

-- El índice de 017 servía `order by created_at desc` (partición por property, no
-- por organización -- a diferencia de despachos.audit_log) -- se recrea para que
-- Postgres pueda resolver `order by created_at desc, seq desc` con un index scan.
drop index hoteles.fraude_audit_log_property_created_idx;
create index fraude_audit_log_property_created_idx on hoteles.fraude_audit_log (property_id, created_at desc, seq desc);
