-- Hueco detectado al diseñar el panel de superadmin (r5, 19-sep-2026): la vertical
-- RENTAS no tiene bitácora de auditoría PROPIA de las acciones del staff -- el
-- break-glass de superadmin (`rentas.break_glass_access_log`, 012_break_glass_audit.sql)
-- es un mecanismo DISTINTO (acceso de EMERGENCIA de un actor de PLATAFORMA fuera del
-- flujo normal), no un registro de lo que el staff normal de un tenant hace día a día
-- (cambiar un precio, cancelar una reserva, registrar un payout, generar un statement
-- de propietario, conectar/desconectar un canal).
--
-- Patrón copiado, no inventado -- se leyeron primero las 2 bitácoras de auditoría de
-- staff que YA existen en el repo antes de diseñar esta:
--   - packages/domain-despachos/migrations/008_despachos_audit_log.sql
--   - packages/domain-hoteles/migrations/017_fraude_audit_log.sql
-- Ambas comparten: tabla mínima (organización/actor/acción/cuándo indexados, resto en
-- un campo libre), RLS de solo-lectura para staff con membership, deny-by-default de
-- INSERT (sin policy para `authenticated`), y escritura exclusiva vía una función
-- `security definer` — PERO ambas reciben el actor como `p_actor_user_id` (un
-- PARÁMETRO), porque su caller (`AuditSink`, ver packages/core-authz/src/audit.ts)
-- escribe desde la SESIÓN DE SISTEMA (`auth.uid()` NULL) de un puerto separado,
-- después de que la escritura de negocio ya corrió en la transacción normal.
--
-- Esta fase se APARTA de esa parte a propósito, por mandato explícito de la tarea:
-- el actor debe venir SIEMPRE de `auth.uid()`, nunca de un parámetro que el código de
-- aplicación pudiera equivocar (o un bug futuro pudiera falsificar). Eso es posible
-- aquí, y no lo era en despachos/hoteles, porque las 6 acciones sensibles reales de
-- rentas que este hallazgo cierra (cambio de precio/tarifa, cancelación/modificación
-- de reserva, payout, ajuste de owner statement, conexión/desconexión de canal iCal)
-- SIEMPRE corren dentro de la MISMA sesión por-request del staff autenticado
-- (`dbSession(deps.engine)` -> `ManagedPostgresEngine.withAppSession({userId: <el
-- staff real>}, ...)`, ver apps/api/src/routes/verticals/rentas/*.ts) -- nunca desde
-- la sesión de sistema. `auth.uid()` YA es el actor real en ese momento; no hace
-- falta (ni conviene) que nadie se lo pase como argumento.
--
-- Deliberadamente SIN jsonb `payload` (a diferencia de despachos/hoteles, que guardan
-- el `AuthzAuditEntry` completo tal cual): el mandato de esta fase es explícito --
-- "sin PII innecesaria ni payloads crudos, guarda qué cambió (campo, antes, después
-- resumido)". `campo`/`antes`/`despues` son texto corto y acotado (nunca una fila
-- completa ni un objeto anidado) -- una desviación deliberada del patrón copiado, no
-- un descuido.
--
-- "Cambios de membresía/rol del staff" (uno de los 6 tipos de acción pedidos) queda
-- FUERA de esta migración: verificado contra el código real antes de construir nada
-- (no asumido) -- a diferencia de citas/despachos/hoteles/licitaciones/restaurantes
-- (cada una con su propia apps/api/src/routes/verticals/<vertical>/admin-staff.ts),
-- RENTAS NO TIENE NINGUNA ruta de gestión de membership/rol de staff todavía. No
-- existe ningún flujo real que auditar -- inventar esa ruta desde cero sería un
-- rediseño de producto ajeno al alcance de esta fase (bitácora de auditoría), no una
-- instrumentación de algo que ya existe. Queda documentado como hueco conocido; el
-- día que esa ruta se construya, debe llamar a `rentas.record_audit_log(...)` con
-- `entity_type = 'membership'` -- por eso el CHECK de `entity_type` de abajo ya deja
-- ese valor reservado en el catálogo, aunque ningún caller lo use todavía.
--
-- Requiere: 0001_core_schema.sql (core.organization, core.staff_user, core.membership).

-- ---------------------------------------------------------------------------
-- 1) rentas.audit_log -- tabla mínima, append-only.
-- ---------------------------------------------------------------------------
create table rentas.audit_log (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  -- `on delete restrict` (nunca `set null`) a propósito: el actor es NOT NULL -- un
  -- registro de auditoría sin saber quién hizo la acción no tiene ningún valor. Mismo
  -- criterio que `rentas.break_glass_access_log.actor_user_id` (012_break_glass_audit.sql).
  actor_user_id uuid not null references core.staff_user(id) on delete restrict,
  -- Ej.: 'pricing.tarifa_base.actualizada', 'reserva.cancelada', 'payout.registrado',
  -- 'owner_statement.generado', 'canal.ical_conectado' -- texto libre corto (no un
  -- enum): nuevas acciones dentro de un `entity_type` ya cubierto no requieren otra
  -- migración, mismo criterio que `action text` en despachos.audit_log.
  action text not null check (char_length(btrim(action)) between 1 and 200),
  -- Catálogo CERRADO (a diferencia de `action`) -- necesario para el filtro por tipo
  -- de la pantalla de auditoría (`GET .../auditoria?tipo=...`). 'membership' queda
  -- reservado sin caller todavía -- ver comentario de cabecera.
  entity_type text not null check (entity_type in ('pricing', 'reserva', 'payout', 'owner_statement', 'membership', 'canal')),
  -- Nulable: no toda acción tiene un id de entidad único y estable (ej. desconectar un
  -- canal identifica la unidad+canal por su combinación, no por un solo uuid).
  entity_id uuid,
  -- Resumen del cambio -- NUNCA una fila completa ni un jsonb crudo (ver cabecera):
  -- qué campo cambió, su valor antes y después, ambos ya resumidos por el caller
  -- (nunca un huésped, nunca un monto sin acotar a lo que la acción reporta).
  campo text check (campo is null or char_length(campo) <= 200),
  antes text check (antes is null or char_length(antes) <= 500),
  despues text check (despues is null or char_length(despues) <= 500),
  created_at timestamptz not null default now()
);

-- `GET .../auditoria` (paginado, más reciente primero) es el patrón de acceso
-- principal -- mismo índice que despachos.audit_log/hoteles.fraude_audit_log. El
-- segundo índice sirve el filtro por tipo de acción que esos dos NO necesitaban
-- (ninguno expone todavía una ruta HTTP real con ese filtro).
create index rentas_audit_log_org_created_idx on rentas.audit_log (organization_id, created_at desc);
create index rentas_audit_log_org_type_created_idx on rentas.audit_log (organization_id, entity_type, created_at desc);

alter table rentas.audit_log enable row level security;

-- Lectura: SOLO owner/admin de la organización (`admin_gestora`, el único rol de
-- rentas con ese alcance -- mismo criterio que PRICING_ESCRITURA_ROLES/
-- FINANZAS_ESCRITURA_ROLES) -- a diferencia de despachos.audit_log (cualquier staff
-- de la organización), esta fase pide explícitamente "lectura... solo para
-- owner/admin de la organización": lo que CADA miembro del staff hizo es información
-- que un compañero sin rol de administración no necesita ver.
create policy "admin_gestora lee la bitacora de auditoria de su organizacion" on rentas.audit_log for select
  using (exists (
    select 1 from core.membership m
    where m.organization_id = audit_log.organization_id
      and m.user_id = auth.uid()
      and m.vertical_role = 'admin_gestora'
  ));

-- Escritura: SOLO vía `rentas.record_audit_log()` (abajo) -- deliberadamente SIN
-- policy de INSERT para `authenticated` (deny-by-default real, mismo criterio que
-- `despachos.audit_log`/`hoteles.fraude_audit_log`/`core.revoked_refresh_token`): ni
-- siquiera un bug futuro que arme un INSERT a mano contra esta tabla podría escribir
-- aquí sin pasar por la función `security definer`.
--
-- Append-only MÁS estricto que despachos.audit_log/hoteles.fraude_audit_log (que solo
-- confían en la ausencia de GRANT de update/delete): esta fase pide explícitamente
-- "sin UPDATE ni DELETE para NADIE" -- ni siquiera `service_role` recibe esos GRANT
-- (mismo criterio que `rentas.break_glass_access_log`), Y ADEMÁS se agregan triggers
-- de bloqueo incondicional (mismo patrón que
-- `rentas.break_glass_access_log_block_mutation`, 012_break_glass_audit.sql) como
-- defensa en profundidad: ni un GRANT futuro accidental podría violar el append-only.
revoke all on rentas.audit_log from public, anon, authenticated;
grant select on rentas.audit_log to authenticated;
grant select, insert on rentas.audit_log to service_role;

create or replace function rentas.audit_log_block_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'rentas_audit_log_append_only: % no está permitido sobre rentas.audit_log', tg_op
    using errcode = '0A000';
end;
$$;

create trigger rentas_audit_log_block_update_trg
  before update on rentas.audit_log
  for each row execute function rentas.audit_log_block_mutation();
create trigger rentas_audit_log_block_delete_trg
  before delete on rentas.audit_log
  for each row execute function rentas.audit_log_block_mutation();

-- ---------------------------------------------------------------------------
-- 2) rentas.record_audit_log -- ÚNICA vía de escritura. El actor SIEMPRE sale de
--    `auth.uid()` (nunca de un parámetro, ver cabecera) -- `security definer` con
--    `search_path` fijo (nunca resuelve un objeto de un schema que el caller pudiera
--    controlar) y `revoke` de `public` (solo `authenticated` puede ejecutarla).
--
--    Defensa en profundidad adicional (no pedida literal, pero necesaria): verifica
--    que el actor SÍ pertenece a `p_organization_id` -- sin este check, cualquier
--    staff autenticado de CUALQUIER organización podría llamar a esta función con el
--    `organization_id` de UN TENANT AJENO y sembrar filas de auditoría falsas en su
--    bitácora (la policy de SELECT de arriba filtra correctamente quién LEE, pero
--    `security definer` bypassa esa misma RLS para el INSERT -- sin este check
--    explícito, el bypass sería total, no solo para el propio tenant). Mismo
--    criterio de "cross-tenant siempre rechazado" que el resto del repo.
-- ---------------------------------------------------------------------------
create or replace function rentas.record_audit_log(
  p_organization_id uuid,
  p_action text,
  p_entity_type text,
  p_entity_id uuid,
  p_campo text,
  p_antes text,
  p_despues text
)
returns uuid
language plpgsql
security definer
set search_path = rentas, core, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_id uuid;
begin
  if v_actor is null then
    raise exception 'rentas.record_audit_log: requiere un actor autenticado (auth.uid() es NULL) -- nunca corre desde la sesion de sistema.'
      using errcode = '28000';
  end if;

  if not exists (select 1 from core.membership m where m.organization_id = p_organization_id and m.user_id = v_actor) then
    raise exception 'rentas.record_audit_log: el actor % no pertenece a la organizacion %.', v_actor, p_organization_id
      using errcode = '42501';
  end if;

  insert into rentas.audit_log (organization_id, actor_user_id, action, entity_type, entity_id, campo, antes, despues)
  values (p_organization_id, v_actor, p_action, p_entity_type, p_entity_id, p_campo, p_antes, p_despues)
  returning id into v_id;

  return v_id;
end;
$$;

revoke all on function rentas.record_audit_log(uuid, text, text, uuid, text, text, text) from public;
-- Mismo rol bajo el que corre TODO este archivo vía `ManagedPostgresEngine.
-- withAppSession` (siempre `set local role authenticated`) -- nunca `anon`, este
-- monorepo no usa ese rol.
grant execute on function rentas.record_audit_log(uuid, text, text, uuid, text, text, text) to authenticated;
