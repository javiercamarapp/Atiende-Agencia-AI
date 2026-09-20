-- FASE 3 (producto) — la vertical CITAS no tiene bitácora de auditoría PROPIA de
-- las acciones del staff (restaurantes/rentas ya la tienen, ver
-- packages/domain-restaurantes/migrations/019_restaurantes_audit_log.sql +
-- packages/domain-rentas/migrations/021_rentas_audit_log.sql/
-- 022_rentas_audit_log_orden_determinista.sql). Este archivo COPIA ese patrón ya
-- probado en `main` (PR #165/#173 rentas, PR #183 restaurantes — el más reciente y
-- ya corregido) y nace YA con las correcciones que a esas dos les costó una
-- segunda migración/una ronda de revisión, en vez de repetir el mismo camino:
--
--   1. Orden TOTAL desde el día uno — `seq bigint generated always as identity`
--      vive en ESTA migración (rentas la agregó recién en el PR #173, r6, porque
--      `created_at default now()` es CONSTANTE dentro de una transacción de
--      Postgres — ver "Date/Time Functions and Operators" en la documentación
--      oficial — y dos filas de la MISMA transacción pueden empatar; sin una
--      columna de desempate único, `order by created_at desc` no es un orden
--      total y la paginación por OFFSET sobre ese empate es INESTABLE). Los 2
--      índices ya se crean con `(..., created_at desc, seq desc)` desde el
--      principio.
--   2. `record_audit_log` valida ROL, no solo membership (mismo criterio que
--      restaurantes.record_audit_log corrigió sobre rentas.record_audit_log, que
--      solo exige membership sin validar rol) — la función exige `vertical_role
--      in ('owner', 'admin', 'staff')`, el catálogo COMPLETO de
--      `@atiende/domain-citas::CITAS_ROLES` (roles.ts) — citas, a diferencia de
--      restaurantes, no tiene un rol disjunto de más bajo privilegio como
--      "repartidor" (ver el comentario de cabecera de roles.ts: "citas nunca
--      distinguió quién del staff puede escribir, ni en el origen ni en las
--      fases ya construidas de esta vertical"), así que hoy CUALQUIER membership
--      real basta para pasar este segundo check — se deja explícito de todas
--      formas (en vez de solo el primer check de membership) para que, el día que
--      citas agregue un rol de más bajo privilegio, esta función ya tenga el
--      techo correcto sin otra migración.
--
-- Patrón copiado literal de restaurantes/rentas en todo lo demás:
--   - Tabla mínima append-only (organización/actor/acción/cuándo indexados, resto
--     en `campo`/`antes`/`despues`, texto corto y acotado -- NUNCA una fila
--     completa ni un jsonb crudo, NUNCA PII de clientes/teléfonos completos/
--     secretos: solo actor, acción, entidad, ids y un resumen mínimo del antes/
--     después).
--   - RLS de solo-lectura para un rol restringido (aquí `owner`/`admin` -- ver
--     apps/api/src/routes/verticals/citas/auditoria.ts --, mandato explícito de
--     esta fase: "lectura ... solo para owner/admin de la organización", mismo
--     criterio que restaurantes.audit_log, más estricto que rentas.audit_log que
--     admite cualquier `admin_gestora`).
--   - Deny-by-default de INSERT (sin policy para `authenticated`) — escritura
--     EXCLUSIVA vía `citas.record_audit_log()`, `security definer` con
--     `search_path` fijo y `revoke` de `public`.
--   - Triggers de bloqueo incondicional de UPDATE/DELETE (defensa en profundidad
--     más allá de la ausencia de GRANT) — ni `service_role` puede.
--   - `on delete restrict` (nunca `cascade`) en las dos FK: el trigger de bloqueo
--     de DELETE de abajo rechaza CUALQUIER DELETE sobre esta tabla, `restrict`
--     expresa exactamente lo mismo sin prometer un cascade que el propio trigger
--     nunca deja completar.
--   - `left(..., N)` DENTRO de la función (nunca solo en TypeScript) — la ÚNICA
--     vía de escritura es esta función, así que es el único lugar donde puede
--     garantizarse, para TODO caller presente y futuro, que el CHECK de longitud
--     de la tabla (200/500/500) nunca se viola.
--   - `service_role` NO recibe `insert`: `security definer` hace que
--     `record_audit_log` corra con los privilegios de su DUEÑO, ningún GRANT de
--     INSERT sobre la TABLA es necesario, y `service_role` tiene `bypassrls` —
--     un GRANT de INSERT aquí sería una vía de escritura DIRECTA con actor
--     arbitrario que ningún caller real usa hoy. Solo `select`.
--
-- Catálogo CERRADO de `entity_type` -- las 5 categorías de acción que esta fase
-- instrumenta (ver comentario de cabecera de
-- apps/api/src/routes/verticals/citas/auditoria.ts para el detalle completo por
-- ruta): 'servicio' (cambios de precio/tarifa), 'cita' (cancelación/reagendo
-- forzado por STAFF, nunca por el cliente/agente), 'staff' (invitación/baja/
-- cambio de rol), 'configuracion' (horarios/disponibilidad/tenant_config —
-- 'whatsapp'/'voz' quedan reservados dentro de este mismo entity_type: verificado
-- contra el código real antes de escribir esta migración que HOY ninguna ruta del
-- panel permite editar `citas.whatsapp_config`/la configuración de voz, ver
-- knownGaps del PR), 'lista_espera' (resolución MANUAL del broadcast, ver
-- POST .../waitlist/broadcast).
--
-- Deliberadamente SIN variante de solo-sistema (`auth.uid() is null`): las 5
-- acciones sensibles reales que esta fase instrumenta SIEMPRE corren en la sesión
-- de STAFF autenticado (`dbSession(deps.engine)` -> `requirePropertyMembership`,
-- ver admin.ts/admin-staff.ts/appointments-lifecycle.ts) — verificado contra el
-- código real antes de escribir esta migración. La ÚNICA acción cuyo EFECTO real
-- corre después en sesión de sistema (el broadcast de lista de espera, ver
-- `runCitasListaEsperaBroadcastAfterCommit` en admin.ts) registra su fila de
-- bitácora ANTES de ese post-commit, dentro de la MISMA sesión de staff que ya
-- validó la solicitud — el actor real (`auth.uid()`) es el staff que decidió
-- disparar el broadcast, nunca la sesión de sistema que luego lo ejecuta. Si
-- algún caller de sistema llega a necesitarlo más adelante, se agrega entonces
-- una variante `citas.record_audit_log_sistema(...)` con `auth.uid() is null`
-- explícito — no se inventa aquí sin un caller real.
--
-- Requiere: 0001_core_schema.sql (core.organization, core.staff_user,
-- core.membership) y 001_citas_schema.sql (citas.*).

-- ---------------------------------------------------------------------------
-- 1) citas.audit_log -- tabla mínima, append-only, orden total desde el día uno.
-- ---------------------------------------------------------------------------
create table citas.audit_log (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete restrict,
  actor_user_id uuid not null references core.staff_user(id) on delete restrict,
  -- Ej.: 'servicio.tarifa_actualizada', 'cita.cancelada_por_staff',
  -- 'staff.invitado', 'configuracion.horario_actualizado',
  -- 'lista_espera.resuelta_manual' -- texto libre corto (no un enum): nuevas
  -- acciones dentro de un `entity_type` ya cubierto no requieren otra migración,
  -- mismo criterio que `action text` en restaurantes.audit_log/rentas.audit_log.
  action text not null check (char_length(btrim(action)) between 1 and 200),
  entity_type text not null check (entity_type in ('servicio', 'cita', 'staff', 'configuracion', 'lista_espera')),
  -- Nulable: no toda acción tiene un id de entidad único y estable (ej. una
  -- resolución manual de lista de espera identifica proveedor/servicio, ya
  -- capturados en `campo`/`despues`, sin un id de fila propio).
  entity_id uuid,
  -- Resumen del cambio -- NUNCA una fila completa ni un jsonb crudo, NUNCA PII de
  -- clientes/teléfonos completos/secretos (mandato explícito de esta fase): qué
  -- campo cambió, su valor antes y después, ambos ya resumidos por el caller.
  campo text check (campo is null or char_length(campo) <= 200),
  antes text check (antes is null or char_length(antes) <= 500),
  despues text check (despues is null or char_length(despues) <= 500),
  created_at timestamptz not null default now(),
  -- Orden TOTAL desde el día uno (ver comentario de cabecera, punto 1) -- nunca
  -- hace falta una migración de corrección como la 022 de rentas.
  seq bigint generated always as identity
);

-- `GET .../admin/auditoria` (paginado, más reciente primero) es el patrón de
-- acceso principal -- mismo índice que restaurantes.audit_log/rentas.audit_log.
-- El segundo índice sirve el filtro por tipo de acción de esa misma ruta. Ambos
-- ya incluyen `seq desc` como desempate (ver punto 1 del comentario de cabecera).
create index citas_audit_log_org_created_idx on citas.audit_log (organization_id, created_at desc, seq desc);
create index citas_audit_log_org_type_created_idx on citas.audit_log (organization_id, entity_type, created_at desc, seq desc);

alter table citas.audit_log enable row level security;

-- Lectura: SOLO owner/admin de la organización -- mandato explícito de esta fase
-- ("lectura ... solo para owner/admin de la organización"), mismo criterio que
-- restaurantes.audit_log (más estricto que rentas.audit_log, que admite
-- cualquier `admin_gestora`) -- un "staff" real de citas (SÍ puede ESCRIBIR, ver
-- la función de abajo) NO debe ver qué hizo cada compañero.
create policy "owner/admin lee la bitacora de auditoria de su organizacion" on citas.audit_log for select
  using (exists (
    select 1 from core.membership m
    where m.organization_id = audit_log.organization_id
      and m.user_id = auth.uid()
      and m.vertical_role in ('owner', 'admin')
  ));

-- Escritura: SOLO vía `citas.record_audit_log()` (abajo) -- deliberadamente SIN
-- policy de INSERT para `authenticated` (deny-by-default real, mismo criterio que
-- restaurantes.audit_log/rentas.audit_log/despachos.audit_log): ni siquiera un
-- bug futuro que arme un INSERT a mano contra esta tabla podría escribir aquí sin
-- pasar por la función `security definer`.
--
-- "Sin UPDATE ni DELETE para NADIE" (mandato explícito de esta fase) -- ni
-- siquiera `service_role` recibe esos GRANT, Y ADEMÁS se agregan triggers de
-- bloqueo incondicional como defensa en profundidad: ni un GRANT futuro
-- accidental podría violar el append-only.
revoke all on citas.audit_log from public, anon, authenticated, service_role;
grant select on citas.audit_log to authenticated, service_role;

create or replace function citas.audit_log_block_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'citas_audit_log_append_only: % no está permitido sobre citas.audit_log', tg_op
    using errcode = '0A000';
end;
$$;

create trigger citas_audit_log_block_update_trg
  before update on citas.audit_log
  for each row execute function citas.audit_log_block_mutation();
create trigger citas_audit_log_block_delete_trg
  before delete on citas.audit_log
  for each row execute function citas.audit_log_block_mutation();

-- ---------------------------------------------------------------------------
-- 2) citas.record_audit_log -- ÚNICA vía de escritura. El actor SIEMPRE sale de
--    `auth.uid()` (nunca de un parámetro que el código de aplicación pudiera
--    equivocar o un bug futuro pudiera falsificar) -- `security definer` con
--    `search_path` fijo (nunca resuelve un objeto de un schema que el caller
--    pudiera controlar) y `revoke` de `public` (solo `authenticated` puede
--    ejecutarla).
--
--    Defensa en profundidad DOBLE (mismo criterio que restaurantes.record_audit_log,
--    ver el punto 2 del comentario de cabecera):
--      a) el actor pertenece a `p_organization_id` -- sin este check, cualquier
--         staff autenticado de CUALQUIER organización podría sembrar filas de
--         auditoría falsas en la bitácora de un tenant ajeno (`security
--         definer` bypassa la policy de SELECT de arriba para el INSERT).
--      b) el `vertical_role` del actor en esa organización es uno de
--         'owner'/'admin'/'staff' (== CITAS_ROLES completo, ver comentario de
--         cabecera punto 2).
--
--    Truncamiento defensivo de `p_campo`/`p_antes`/`p_despues` con `left(...)`
--    DESDE EL DÍA UNO: esta función es la ÚNICA vía de escritura -- por eso es
--    el único lugar donde puede garantizarse, para TODO caller presente y
--    futuro, que el CHECK de longitud de la tabla (200/500/500) nunca se viola.
--    `left(..., N)` nunca falla sobre NULL (devuelve NULL).
-- ---------------------------------------------------------------------------
create or replace function citas.record_audit_log(
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
set search_path = citas, core, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_vertical_role text;
  v_id uuid;
begin
  if v_actor is null then
    raise exception 'citas.record_audit_log: requiere un actor autenticado (auth.uid() es NULL) -- nunca corre desde la sesion de sistema.'
      using errcode = '28000';
  end if;

  select m.vertical_role into v_vertical_role
  from core.membership m
  where m.organization_id = p_organization_id and m.user_id = v_actor;

  if v_vertical_role is null then
    raise exception 'citas.record_audit_log: el actor % no pertenece a la organizacion %.', v_actor, p_organization_id
      using errcode = '42501';
  end if;

  if v_vertical_role not in ('owner', 'admin', 'staff') then
    raise exception 'citas.record_audit_log: el rol % del actor % no puede escribir en la bitacora de auditoria.', v_vertical_role, v_actor
      using errcode = '42501';
  end if;

  insert into citas.audit_log (organization_id, actor_user_id, action, entity_type, entity_id, campo, antes, despues)
  values (p_organization_id, v_actor, p_action, p_entity_type, p_entity_id, left(p_campo, 200), left(p_antes, 500), left(p_despues, 500))
  returning id into v_id;

  return v_id;
end;
$$;

-- `from public, anon` -- no solo `public` -- porque `anon` SÍ se usa en este
-- monorepo (varias migraciones de citas otorgan SELECT a `anon` sobre catálogo
-- público) y porque un `ALTER DEFAULT PRIVILEGES` preexistente en el Supabase
-- real de este proyecto puede conceder EXECUTE directo a `anon` sobre una
-- función NUEVA (ver `packages/db/migrations/0016_superadmin_acciones.sql`) --
-- un `revoke ... from public` no retira ese grant por defecto, hay que
-- revocarlo también de `anon` explícitamente. No es explotable hoy (el guard
-- `auth.uid() is null` de arriba rechaza a `anon` con 28000 de todas formas),
-- pero la migración es inmutable una vez en `main` -- corregirlo después
-- costaría una segunda migración.
revoke all on function citas.record_audit_log(uuid, text, text, uuid, text, text, text) from public, anon;
grant execute on function citas.record_audit_log(uuid, text, text, uuid, text, text, text) to authenticated;
