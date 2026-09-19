-- Corrige un lost-update real en `core.confirmar_superadmin_action_intent_for_
-- superadmin` (rama `cerrar_prospecto`, `0016_superadmin_acciones.sql` L713-722):
-- el comentario de esa migración (L699-702) promete "re-valida el estado ACTUAL
-- del mundo real antes de ejecutar (dentro de cada rama)", y la rama
-- `reencolar_mensaje_muerto` sí lo hace (`core._reencolar_mensaje_muerto`
-- re-valida `status = 'dead'` en el propio WHERE del UPDATE) -- pero la rama
-- `cerrar_prospecto` NUNCA vuelve a mirar el prospecto: valida solo que el
-- `estado` GUARDADO EN EL PAYLOAD al crear el intent (hace hasta 5 minutos,
-- `apps/api/src/routes/superadmin-acciones.ts` `crearIntent(..., 5)`) esté en
-- ('perdido','descartado'), y llama directo a
-- `core.update_prospecto_for_superadmin`, cuyo UPDATE es `where id =
-- p_prospecto_id` sin condición sobre estado ni `updated_at`. Si OTRO
-- superadmin edita el mismo prospecto (por el editor normal,
-- `apps/web/src/superadmin/pages/Acciones.tsx` nunca refresca el resumen
-- guardado) o lo cierra primero entre el POST que crea el intent y el POST que
-- lo confirma, la confirmación lo pisa igual -- último-en-escribir-gana sin que
-- nadie lo sepa (la ruta ni el repositorio TS tienen ningún guard para esto).
--
-- Nunca se edita una migración ya aplicada (`0016_superadmin_acciones.sql`) --
-- `create or replace function` de la MISMA función, copiada tal cual salvo la
-- rama `cerrar_prospecto`: se agrega un `select ... for update` del prospecto
-- (dentro de la misma transacción que ya abre la función, así que el lock se
-- libera solo al terminar) y, si no existe, cambió DESPUÉS de que se creó el
-- intent (`updated_at > v_intent.creado_en`) o ya está en un estado terminal,
-- se lanza una excepción con motivo claro. Cae en el `exception when others`
-- YA existente de la función (L740-745 de 0016) -- deja el intent en `failed`
-- con `error` poblado, exactamente el mismo camino que ya usa
-- `reencolar_mensaje_muerto` cuando su re-validación falla (escenario 23 de
-- `scripts/verify-superadmin-acciones/assertions.sql`). No hace falta migrar
-- ninguna otra pieza: el payload del intent ya guardaba `prospectoId`/`estado`
-- desde 0016, y `core.prospecto` no tiene trigger de `updated_at` --
-- `core.update_prospecto_for_superadmin` lo fija a mano (`0016` L142) y
-- `core._marcar_prospectos_sin_movimiento` (el único otro escritor de la fila)
-- únicamente toca `necesita_seguimiento_desde`, nunca `updated_at` (`0016`
-- L386) -- así que compararlo contra `v_intent.creado_en` no produce falsos
-- conflictos por ese cron.
--
-- Conserva EXACTOS: `security definer`, `set search_path = core, pg_temp`, el
-- guard de caller binding (`auth.uid() = p_caller_id`), el guard de superadmin
-- (`core.is_platform_superadmin(p_caller_id)`, L74-76 de este archivo -- SÍ se
-- revalida en CADA llamada a esta función, idéntico a `0016` L673-675; no es
-- "implícito" ni confía solo en que el intent fue creado por un superadmin
-- real), y el `revoke from public` + `grant to authenticated` -- ninguno
-- cambia con este arreglo, la firma de la función es la misma.
--
-- Solo SQL: ningún código TypeScript cambia (la función devuelve el mismo tipo
-- `core.superadmin_action_intent`, la excepción cae en la misma rama `catch`
-- ya manejada por `apps/api/src/routes/superadmin-acciones.ts`). Sin cambios
-- de esquema, sin fallback 42883/42P01/42703: no se agrega ninguna tabla,
-- columna ni función nueva a la que el código TS pueda llamar contra una base
-- vieja -- es un `create or replace` de una función que YA existe con la misma
-- firma.
create or replace function core.confirmar_superadmin_action_intent_for_superadmin(p_caller_id uuid, p_intent_id uuid)
returns core.superadmin_action_intent
language plpgsql
security definer
set search_path = core, pg_temp
as $$
declare
  v_intent core.superadmin_action_intent;
  v_queue text;
  v_mensaje_id uuid;
  v_prospecto_id uuid;
  v_estado_destino text;
  v_prospecto core.prospecto;
  v_reencolado boolean;
  v_outbox jsonb;
  v_prospectos jsonb;
  v_resultado jsonb;
begin
  if auth.uid() is null or auth.uid() <> p_caller_id then
    raise exception 'confirmar_superadmin_action_intent_for_superadmin: el caller autenticado debe coincidir con p_caller_id' using errcode = '42501';
  end if;
  if not core.is_platform_superadmin(p_caller_id) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  update core.superadmin_action_intent
  set confirmado_en = now()
  where id = p_intent_id and estado = 'pending' and creado_por = p_caller_id and confirmado_en is null and vence_en > now()
  returning * into v_intent;

  if v_intent.id is null then
    select * into v_intent from core.superadmin_action_intent where id = p_intent_id;
    if v_intent.id is null then
      raise exception 'intent no encontrado' using errcode = 'P0002';
    end if;
    if v_intent.creado_por is distinct from p_caller_id then
      raise exception 'este intent no fue creado por este superadmin' using errcode = '42501';
    end if;
    if v_intent.estado = 'pending' and v_intent.vence_en <= now() then
      update core.superadmin_action_intent set estado = 'expired' where id = p_intent_id and estado = 'pending' returning * into v_intent;
    end if;
    -- `v_intent.estado` ya no es un 'pending' confirmable (expired/executed/
    -- failed/cancelled/ganado por una llamada concurrente) -- se devuelve
    -- TAL CUAL, sin ejecutar nada.
    return v_intent;
  end if;

  -- A partir de aquí el intent está EXCLUSIVAMENTE reclamado por esta
  -- llamada. Re-valida el estado ACTUAL del mundo real antes de ejecutar
  -- (dentro de cada rama) -- nunca se asume que sigue siendo cierto lo que
  -- decía el resumen al crearse el intent.
  begin
    if v_intent.tipo = 'reencolar_mensaje_muerto' then
      v_queue := v_intent.payload ->> 'queue';
      v_mensaje_id := (v_intent.payload ->> 'mensajeId')::uuid;
      v_reencolado := core._reencolar_mensaje_muerto(p_intent_id, v_queue, v_mensaje_id);
      if not v_reencolado then
        raise exception 'el mensaje % de la cola % ya no está en estado dead (lo movieron, ya se reencoló antes, o ya no existe)', v_mensaje_id, v_queue;
      end if;
      v_resultado := jsonb_build_object('reencolado', true, 'queue', v_queue, 'mensajeId', v_mensaje_id);

    elsif v_intent.tipo = 'cerrar_prospecto' then
      v_prospecto_id := (v_intent.payload ->> 'prospectoId')::uuid;
      v_estado_destino := v_intent.payload ->> 'estado';
      if v_estado_destino not in ('perdido', 'descartado') then
        raise exception 'estado destino inválido para cerrar_prospecto: %', v_estado_destino;
      end if;
      -- Re-valida el estado ACTUAL del prospecto (lock de fila real, se
      -- libera solo al terminar esta transacción) -- ANTES de esta migración
      -- esta rama era la ÚNICA de las tres que NO re-validaba nada (ver el
      -- comentario de cabecera de este archivo). Tres rechazos posibles, cada
      -- uno con su propio mensaje para que quede claro en `error` cuál pasó:
      -- el prospecto ya no existe, cambió DESPUÉS de que se creó este intent
      -- (otro superadmin lo editó mientras tanto), o ya estaba en un estado
      -- terminal desde ANTES de que se creara el intent (alguien más lo
      -- cerró, o incluso lo reabrió y volvió a cerrar de otra forma). Reduce
      -- drásticamente -- no elimina del todo -- la ventana del lost-update:
      -- queda una carrera residual de milisegundos si la transacción
      -- concurrente EMPEZÓ antes de `creado_en` del intent pero hizo commit
      -- después (`now()` es el inicio de la transacción de esta función, no
      -- el momento del commit ajeno); aceptable para este hallazgo, que era
      -- de severidad baja y con ventana real de hasta 5 minutos.
      select * into v_prospecto from core.prospecto where id = v_prospecto_id for update;
      if v_prospecto.id is null then
        raise exception 'el prospecto % ya no existe; no se puede cerrar', v_prospecto_id;
      elsif v_prospecto.updated_at > v_intent.creado_en then
        raise exception 'el prospecto cambió después de crear este intent (estado actual: %); es necesario crear el intent de nuevo', v_prospecto.estado;
      elsif v_prospecto.estado in ('ganado', 'perdido', 'descartado') then
        raise exception 'el prospecto ya estaba en un estado terminal (%) cuando se creó este intent; no se re-ejecuta', v_prospecto.estado;
      end if;
      -- Reutiliza la función YA existente (misma que usa el editor de
      -- prospectos) -- nunca duplica su validación/lógica.
      v_prospecto := core.update_prospecto_for_superadmin(p_caller_id, v_prospecto_id, v_estado_destino, null);
      v_resultado := jsonb_build_object('prospectoId', v_prospecto.id, 'estado', v_prospecto.estado);

    elsif v_intent.tipo = 'ejecutar_mantenimiento_ahora' then
      -- MISMAS dos funciones internas que corre el cron -- un solo código
      -- real detrás de ambos caminos.
      select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) into v_outbox from core._desatascar_outbox_colgados(30) x;
      select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) into v_prospectos from core._marcar_prospectos_sin_movimiento(14) x;
      v_resultado := jsonb_build_object('outbox', v_outbox, 'prospectos', v_prospectos);

    else
      raise exception 'tipo de intent no ejecutable: %', v_intent.tipo;
    end if;

    update core.superadmin_action_intent
    set estado = 'executed', ejecutado_en = now(), resultado = v_resultado, error = null
    where id = p_intent_id
    returning * into v_intent;

  exception when others then
    update core.superadmin_action_intent
    set estado = 'failed', ejecutado_en = now(), error = left(sqlerrm, 500)
    where id = p_intent_id
    returning * into v_intent;
  end;

  return v_intent;
end;
$$;

revoke all on function core.confirmar_superadmin_action_intent_for_superadmin(uuid, uuid) from public;
grant execute on function core.confirmar_superadmin_action_intent_for_superadmin(uuid, uuid) to authenticated;
