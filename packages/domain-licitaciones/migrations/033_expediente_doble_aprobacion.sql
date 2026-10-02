-- L-26 (REQ-044): doble aprobacion del expediente antes de ensamblar el paquete.
--   (1/2) aprobacion tecnico-legal y (2/2) aprobacion economica, dadas por DOS personas distintas.
-- Requiere: 004_granular_approvals.sql (`licitaciones.approval`) y 002 (`can_decide_org`).
--
-- Que agrega (sin ningun GRANT nuevo, sin `using (true)`, nada para anon):
--   1. `licitaciones.approval.stage` -- columna nullable ('tecnica_legal' | 'economica'). NULL = aprobacion
--      de seccion o la aprobacion unica anterior a esta migracion. CHECK: solo el alcance 'expediente'
--      puede llevar etapa.
--   2. Indice unico parcial: a lo mas UNA aprobacion vigente por (propuesta, etapa) -- respaldo en la base
--      de la regla "nunca coexisten dos vigentes del mismo alcance" frente a requests cruzados.
--   3. Trigger `approval_stage_actores_distintos` (BEFORE INSERT, SIN security definer: corre como quien
--      llama y solo lee filas que la RLS ya le deja ver): serializa por propuesta con un candado de
--      transaccion y rechaza (23514) (a) que la misma persona de las dos etapas vigentes y (b) una
--      economica sin tecnico-legal vigente para el MISMO hash de insumos. La regla ya vive en
--      `approval-workflow.ts`; el trigger es la defensa en profundidad para que dos requests simultaneos o
--      una escritura que se salte la capa de aplicacion no puedan completar el 2/2 con una sola persona.
--   4. Policy de INSERT reemplazada: ademas de `can_decide_org`, una aprobacion CON etapa exige
--      `approver_id = auth.uid()` -- nadie puede registrar la etapa "a nombre de" otra persona para
--      aparentar dos aprobadores.
--
-- Justificacion de GRANT: ninguno nuevo. `authenticated` ya tenia `insert, update` sobre
-- `licitaciones.approval` (004); la columna nueva queda cubierta por ese grant y por las mismas policies
-- (insert/update solo DECISION_ROLES de la organizacion). El grant de columna no aplica: la capa de
-- aplicacion escribe ya casi todas las columnas de la fila.
--
-- Datos existentes (DECISION DOCUMENTADA): las aprobaciones de expediente 'vigente' de la era de aprobacion
-- unica se INVALIDAN con motivo 'migrada_a_doble_aprobacion_033' (no se convierten en 1/2). Aprobaron todo el
-- expediente sin distinguir etapa ni segunda persona; tratarlas como tecnico-legal concederia una etapa que
-- nadie dio como tal. El historial se conserva (nada se borra); un expediente ya aprobado debe repetir las dos
-- aprobaciones. Un paquete 'ready' ya ensamblado se re-deriva contra el estado vivo (AE-14) y vuelve a
-- 'draft' hasta completar el 2/2.
--
-- Compatibilidad con la base sin migrar: el codigo TypeScript detecta la falta de `stage` (42703) dentro de
-- un SAVEPOINT y sigue con la aprobacion unica de siempre. Orden de despliegue: esta migracion puede
-- aplicarse antes o despues del codigo.

alter table licitaciones.approval add column stage text;

alter table licitaciones.approval
  add constraint approval_stage_valida check (
    stage is null or (scope = 'expediente' and scope_ref = 'expediente' and stage in ('tecnica_legal', 'economica'))
  );

create unique index approval_expediente_stage_vigente_uidx
  on licitaciones.approval (proposal_id, stage)
  where status = 'vigente' and stage is not null;

-- Decision de datos previos (ver cabecera).
update licitaciones.approval
   set status = 'invalidada',
       invalidated_at = now(),
       invalidated_reason = 'migrada_a_doble_aprobacion_033'
 where scope = 'expediente' and stage is null and status = 'vigente';

create or replace function licitaciones.approval_stage_actores_distintos()
returns trigger language plpgsql set search_path = pg_catalog, licitaciones as $$
begin
  if new.stage is null or new.status <> 'vigente' then
    return new;
  end if;
  -- Serializa las aprobaciones de una misma propuesta dentro de la transaccion.
  perform pg_advisory_xact_lock(hashtextextended(new.proposal_id::text, 33));

  if exists (
    select 1 from licitaciones.approval a
     where a.proposal_id = new.proposal_id
       and a.status = 'vigente'
       and a.scope_ref = 'expediente'
       and a.stage is not null
       and a.stage <> new.stage
       and a.approver_id = new.approver_id
  ) then
    raise exception 'doble_aprobacion_mismo_actor: la aprobacion tecnico-legal y la economica deben darlas dos personas distintas'
      using errcode = '23514';
  end if;

  if new.stage = 'economica' and not exists (
    select 1 from licitaciones.approval a
     where a.proposal_id = new.proposal_id
       and a.status = 'vigente'
       and a.scope_ref = 'expediente'
       and a.stage = 'tecnica_legal'
       and a.inputs_hash = new.inputs_hash
  ) then
    raise exception 'tecnica_legal_requerida_para_economica: falta la aprobacion tecnico-legal vigente para estos insumos'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

revoke all on function licitaciones.approval_stage_actores_distintos() from public, anon;

create trigger approval_stage_actores_distintos
  before insert on licitaciones.approval
  for each row execute function licitaciones.approval_stage_actores_distintos();

-- Policy de INSERT: misma que 004 + la etapa solo la registra quien aprueba (`approver_id = auth.uid()`).
drop policy if exists "decisión: roles de decisión aprueban" on licitaciones.approval;
create policy "decisión: roles de decisión aprueban" on licitaciones.approval
  for insert with check (
    licitaciones.can_decide_org(organization_id)
    and (stage is null or approver_id = auth.uid())
  );
