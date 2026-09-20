-- FASE 3 (producto) + 2 hallazgos de FASE 2 -- ver AGENTS.md de esta tarea
-- (f3-rentas-bitacora-y-guards). Este archivo cierra 3 cosas distintas sobre
-- `021_rentas_audit_log.sql`/`022_rentas_audit_log_orden_determinista.sql`:
--
--   A) COBERTURA DE LA BITÁCORA -- 4 acciones sensibles que el diseño original de
--      021 (comentario de cabecera de esa migración) documentó como pendientes o
--      simplemente no cubrió, ahora instrumentadas:
--        - Movimiento financiero de una reserva (cargo/abono/ajuste) -- POST
--          .../reservas/:ocupacionId/movimiento, ver apps/api/src/routes/
--          verticals/rentas/finanzas.ts. Reutiliza el `entity_type = 'reserva'`
--          que ya existe (misma entidad que reserva.creada/modificada/cancelada,
--          nunca un catálogo nuevo solo para esta acción).
--        - Cancelar un BLOQUEO de disponibilidad -- POST .../bloqueos/:ocupacionId/
--          cancelar, ver bloqueos.ts. Nuevo `entity_type = 'bloqueo'` (un bloqueo
--          no es una reserva -- mismo criterio de "entidad de negocio distinta"
--          que ya separa 'pricing'/'reserva'/'payout'/'owner_statement'/'canal').
--        - Alta de acceso de un propietario (owner_credential) -- POST .../owners/
--          :ownerId/portal-invite, ver owner-portal-invite.ts. Nuevo
--          `entity_type = 'owner_credential'`.
--        - Cambios de membership/rol de staff en rentas -- SIGUE FUERA de esta
--          migración: verificado contra el código real antes de tocar nada (no
--          asumido, mismo criterio que 021) -- rentas TODAVÍA no tiene ninguna
--          ruta de gestión de membership/rol de staff (a diferencia de
--          citas/despachos/hoteles/licitaciones/restaurantes, cada una con su
--          propio admin-staff.ts). 'membership' sigue reservado en el catálogo
--          sin caller, exactamente como 021 ya lo dejó documentado -- inventar esa
--          ruta desde cero sería un rediseño de producto ajeno al alcance de esta
--          tarea (bitácora + guards), no una instrumentación de algo que ya
--          existe. Queda en knownGaps del PR.
--
--   B) `rentas.record_audit_log` NO VALIDABA ROL -- hallazgo ya documentado en el
--      comentario de revisión r5 de 021 ("no bloqueante #9"): la función solo
--      exigía que el actor perteneciera a la organización (`core.membership`),
--      nunca su `vertical_role` -- un staff de bajo privilegio con SQL directo
--      podía sembrar filas de auditoría arbitrarias. Se corrige aquí siguiendo el
--      patrón que `restaurantes.record_audit_log` (PR #183,
--      packages/domain-restaurantes/migrations/019_restaurantes_audit_log.sql)
--      ya adoptó desde el día uno para esa vertical: la función exige un
--      `vertical_role` mínimo.
--
--      Rentas NO tiene roles literales 'owner'/'admin' (a diferencia de
--      restaurantes) -- `RENTAS_VERTICAL_ROLES` (packages/domain-rentas/src/
--      roles.ts) es
--      ['admin_gestora', 'operador:acceso_total', 'operador:calendario_mensajeria',
--       'operador:solo_calendario', 'contador', 'limpieza']. El "techo mínimo que
--      ya usan las demás funciones sensibles de rentas" (mandato de esta tarea)
--      se calculó como la UNIÓN de `assertVerticalRole(...)` de TODA ruta HTTP
--      que hoy llama a `registrarAuditoria` (verificado contra el código real,
--      no inventado):
--        - `admin_gestora`               -- PRICING_ESCRITURA_ROLES,
--                                           FINANZAS_ESCRITURA_ROLES,
--                                           CANCELAR_ROLES,
--                                           ESCRITURA_CALENDARIO_ROLES,
--                                           SYNC_CALENDARIO_ESCRITURA_ROLES,
--                                           FINANZAS_LECTURA_ROLES.
--        - `operador:acceso_total`       -- CANCELAR_ROLES,
--                                           ESCRITURA_CALENDARIO_ROLES,
--                                           SYNC_CALENDARIO_ESCRITURA_ROLES.
--        - `operador:calendario_mensajeria` -- ESCRITURA_CALENDARIO_ROLES,
--                                              SYNC_CALENDARIO_ESCRITURA_ROLES.
--        - `contador`                    -- FINANZAS_LECTURA_ROLES (único rol,
--                                           además de admin_gestora, que puede
--                                           invitar a un propietario al portal,
--                                           ver owner-portal-invite.ts).
--      `operador:solo_calendario` (rol de SOLO lectura, ver el comentario de
--      cabecera de roles.ts -- "existe específicamente para poder VER el
--      calendario sin poder tocarlo") y `limpieza` (LIMPIEZA_OPERACION_ROLES no
--      llama a `registrarAuditoria` hoy -- verificado, ningún módulo de limpieza
--      escribe en esta bitácora) quedan FUERA -- ninguna ruta real de escritura
--      sensible los admite hoy; si alguno llegara a necesitarlo, se agrega
--      entonces con su propia migración, mismo criterio que 'membership' arriba.
--
--      Mismo criterio que restaurantes: defensa en profundidad, nunca el único
--      guardia -- la RLS de lectura y el `assertVerticalRole` de TypeScript de
--      cada ruta siguen siendo la primera línea; este check solo cierra la
--      ventana de "SQL directo" que `security definer` deja abierta.
--
--   C) `search_path` FIJO en 2 funciones que salieron en `get_advisors` sin él
--      (hallazgo de FASE 2, "function_search_path_mutable"):
--        - `rentas.audit_log_block_mutation()` (021) -- trigger de bloqueo total,
--          nunca `security definer`, nunca resuelve ningún objeto sin calificar
--          (solo usa `tg_op`, una variable implícita del propio trigger) -- el
--          fix mínimo suficiente es `set search_path = pg_temp` (ningún schema
--          de negocio que resolver), SIN tocar la lógica.
--        - `rentas.break_glass_session_guard_update()` (018_break_glass_wiring.sql)
--          -- mismo caso exacto: trigger de bloqueo parcial que solo compara
--          `old`/`new` y hace `raise exception`, ningún objeto sin calificar que
--          resolver. Mismo fix, mismo criterio, SIN tocar la lógica (las 2
--          comparaciones y las 2 excepciones quedan carácter por carácter
--          idénticas al archivo original).
--
-- Requiere: 021_rentas_audit_log.sql, 018_break_glass_wiring.sql.

-- ---------------------------------------------------------------------------
-- A) Catálogo de entity_type -- agrega 'bloqueo' y 'owner_credential'. Postgres
--    no admite ALTER de un CHECK existente in-place -- se DROP + ADD con el
--    nombre autogenerado por Postgres para ese CHECK, `audit_log_entity_type_check`
--    -- convención por defecto `<tabla>_<columna>_check`, SIN el schema como
--    prefijo (mismo criterio que el resto del repo, ver p.ej.
--    `appointment_audit_events_event_type_check` en
--    packages/domain-citas/migrations/006_reassign_appointment.sql).
-- ---------------------------------------------------------------------------
alter table rentas.audit_log drop constraint audit_log_entity_type_check;
alter table rentas.audit_log add constraint audit_log_entity_type_check
  check (entity_type in ('pricing', 'reserva', 'payout', 'owner_statement', 'membership', 'canal', 'bloqueo', 'owner_credential'));

-- ---------------------------------------------------------------------------
-- B) rentas.record_audit_log -- agrega la validación de rol (ver cabecera). Todo
--    lo demás es IDÉNTICO a 021 (mismo actor de auth.uid(), mismo check
--    cross-tenant, mismo left() de truncamiento) -- `create or replace` porque
--    la FIRMA no cambia.
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
  v_vertical_role text;
  v_id uuid;
begin
  if v_actor is null then
    raise exception 'rentas.record_audit_log: requiere un actor autenticado (auth.uid() es NULL) -- nunca corre desde la sesion de sistema.'
      using errcode = '28000';
  end if;

  select m.vertical_role into v_vertical_role
  from core.membership m
  where m.organization_id = p_organization_id and m.user_id = v_actor;

  if v_vertical_role is null then
    raise exception 'rentas.record_audit_log: el actor % no pertenece a la organizacion %.', v_actor, p_organization_id
      using errcode = '42501';
  end if;

  -- Techo mínimo -- ver cabecera de esta migración para la justificación
  -- completa de por qué estos 4 roles y no otros.
  if v_vertical_role not in ('admin_gestora', 'operador:acceso_total', 'operador:calendario_mensajeria', 'contador') then
    raise exception 'rentas.record_audit_log: el rol % del actor % no puede escribir en la bitacora de auditoria.', v_vertical_role, v_actor
      using errcode = '42501';
  end if;

  -- `left(..., N)` -- nunca falla sobre NULL (devuelve NULL) -- garantiza que el
  -- CHECK de longitud de la tabla (200/500/500) no pueda violarse aquí, sin
  -- importar qué texto libre arme cada caller (ver comentario de cabecera de
  -- 021_rentas_audit_log.sql).
  insert into rentas.audit_log (organization_id, actor_user_id, action, entity_type, entity_id, campo, antes, despues)
  values (p_organization_id, v_actor, p_action, p_entity_type, p_entity_id, left(p_campo, 200), left(p_antes, 500), left(p_despues, 500))
  returning id into v_id;

  return v_id;
end;
$$;

-- El `revoke`/`grant` de 021 sigue vigente (create or replace no los toca), se
-- repiten aquí de forma idempotente por claridad y porque `create or replace
-- function` a veces se sale de una migración ya aplicada a mano en algún
-- entorno intermedio -- mismo criterio defensivo que el resto del repo.
revoke all on function rentas.record_audit_log(uuid, text, text, uuid, text, text, text) from public;
grant execute on function rentas.record_audit_log(uuid, text, text, uuid, text, text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- C) search_path fijo -- 2 funciones, sin tocar su lógica. Body carácter por
--    carácter idéntico al original, solo se agrega `set search_path = pg_temp`
--    a la firma.
-- ---------------------------------------------------------------------------
create or replace function rentas.audit_log_block_mutation()
returns trigger
language plpgsql
set search_path = pg_temp
as $$
begin
  raise exception 'rentas_audit_log_append_only: % no está permitido sobre rentas.audit_log', tg_op
    using errcode = '0A000';
end;
$$;

create or replace function rentas.break_glass_session_guard_update()
returns trigger
language plpgsql
set search_path = pg_temp
as $$
begin
  if old.actor_user_id is distinct from new.actor_user_id
     or old.organization_id is distinct from new.organization_id
     or old.reason is distinct from new.reason
     or old.opened_at is distinct from new.opened_at
     or old.expires_at is distinct from new.expires_at
  then
    raise exception 'break_glass_session_immutable: solo el cierre (closed_at/closed_by) puede escribirse después del alta -- ningún otro campo de rentas.break_glass_session puede modificarse'
      using errcode = '0A000';
  end if;
  if old.closed_at is not null then
    raise exception 'break_glass_session_immutable: esta sesión ya está cerrada -- no puede reabrirse ni volver a cerrarse'
      using errcode = '0A000';
  end if;
  return new;
end;
$$;
