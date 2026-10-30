-- Fixtures + escenarios contra Postgres REAL del seed de la cuenta demo de rentas (Rn-33): el bloque plpgsql REAL del seed
-- (packages/domain-rentas/src/seed/rentas-demo.ts, generado abajo como public.seed_rentas_demo()) contra TODAS las migraciones reales,
-- con RLS/GRANT/auth.uid() reales. Cada escenario corre en su propio `begin; ... rollback;` y ejecuta el seed dentro de la transaccion;
-- el gate (scripts/verify-real-postgres-ci/run-gate.mjs) evalua UN valor por escenario: el alias `..._deberia_ser_N` (o `should_fail`).
--
--   A. Resultado: 3 propiedades, 5 unidades, 3 propietarios, 21 reservas (8 importadas de los .ics + 13 directas), 3 feeds (1 en cuarentena),
--      1 conflicto abierto, 5 tareas (1 vencida), 1 incidencia, 5 plantillas (2 aprobadas), 2 borradores pendientes, 4 reglas de comision
--      confirmadas, 9 movimientos financieros coherentes; todo ficticio y marcado (slug demo-).
--   B. Lo que ven el Resumen, los reportes, el monitor y el checklist de onboarding (Rn-36): las MISMAS consultas que los repositorios,
--      ejecutadas como el staff autenticado del dueño (RLS real), devuelven datos.
--   C. Idempotencia: dos ejecuciones no duplican nada; no pisa lo que el usuario ya edito (regla de comision, plantilla aprobada).
--   D. Aislamiento y seguridad: aborta si el slug es de otra vertical o si el correo del dueño no existe; otra organizacion no ve nada; anon no lee;
--      borrar la organizacion demo se lleva TODO lo suyo (cascada) sin tocar a otra organizacion.
\set ON_ERROR_STOP off
\pset pager off

-- GENERADO: funciones con el cuerpo real del seed (packages/domain-rentas/src/seed/rentas-demo.ts). No editar a mano:
-- node --experimental-strip-types scripts/verify-rentas-seed/generar-assertions.ts
create or replace function public.seed_rentas_demo() returns void language plpgsql as $seed_fn$
declare
  v jsonb := $rd${"seedVersion":"rentas-demo-1","organizacion":{"slug":"demo-rentas-gestora","nombre":"Gestora Demo Rentas (demo)"},"propietarios":[{"clave":"ana","nombre":"Ana Demo Propietaria","email":"ana.propietaria@example.test"},{"clave":"beto","nombre":"Beto Demo Propietario","email":"beto.propietario@example.test"},{"clave":"carla","nombre":"Carla Demo Propietaria","email":"carla.propietaria@example.test"}],"propiedades":[{"nombre":"Casa del Mar (demo)","zonaHoraria":"America/Cancun","accesoActivo":true,"unidades":[{"nombre":"Depto 1","propietario":"ana","duracionMinimaNoches":2,"tarifaBaseCentavos":180000,"temporada":{"nombre":"Temporada alta demo","desde":20,"hasta":40,"precioCentavos":240000}},{"nombre":"Depto 2","propietario":"ana","duracionMinimaNoches":2,"tarifaBaseCentavos":165000,"temporada":null}]},{"nombre":"Loft Centro (demo)","zonaHoraria":"America/Mexico_City","accesoActivo":false,"unidades":[{"nombre":"Loft A","propietario":"beto","duracionMinimaNoches":1,"tarifaBaseCentavos":120000,"temporada":null}]},{"nombre":"Villa Los Pinos (demo)","zonaHoraria":"America/Merida","accesoActivo":false,"unidades":[{"nombre":"Villa","propietario":"carla","duracionMinimaNoches":3,"tarifaBaseCentavos":350000,"temporada":null},{"nombre":"Cabaña","propietario":"carla","duracionMinimaNoches":2,"tarifaBaseCentavos":140000,"temporada":null}]}],"feeds":[{"propiedad":"Casa del Mar (demo)","unidad":"Depto 1","canal":"airbnb","url":"https://calendarios.demo.invalid/ical/airbnb-casa-del-mar-depto-1.ics","estado":"ok"},{"propiedad":"Casa del Mar (demo)","unidad":"Depto 1","canal":"booking","url":"https://calendarios.demo.invalid/ical/booking-casa-del-mar-depto-1.ics","estado":"ok"},{"propiedad":"Loft Centro (demo)","unidad":"Loft A","canal":"vrbo","url":"https://calendarios.demo.invalid/ical/vrbo-loft-centro-loft-a.ics","estado":"cuarentena"}],"reservas":[{"externalId":"demo-abnb-0001@airbnb.example","propiedad":"Casa del Mar (demo)","unidad":"Depto 1","canal":"airbnb","desde":-14,"noches":3,"origen":"ical","dtstamp":"2026-01-01T12:00:00Z","huesped":null,"contacto":null,"financiero":{"brutoCentavos":540000,"yaNeto":true,"comisionCanalBasisPoints":0,"comisionCanalFuente":"Demo: valor ilustrativo de la cuenta demo, no es la tarifa oficial del canal","comisionCanalCentavos":0,"comisionGestorBasisPoints":2000,"comisionGestorCentavos":108000,"montoRecibidoCentavos":540000,"gastosCentavos":0,"netoCentavos":432000}},{"externalId":"demo-abnb-0002@airbnb.example","propiedad":"Casa del Mar (demo)","unidad":"Depto 1","canal":"airbnb","desde":-3,"noches":3,"origen":"ical","dtstamp":"2026-01-01T12:00:00Z","huesped":null,"contacto":null,"financiero":{"brutoCentavos":540000,"yaNeto":true,"comisionCanalBasisPoints":0,"comisionCanalFuente":"Demo: valor ilustrativo de la cuenta demo, no es la tarifa oficial del canal","comisionCanalCentavos":0,"comisionGestorBasisPoints":2000,"comisionGestorCentavos":108000,"montoRecibidoCentavos":540000,"gastosCentavos":0,"netoCentavos":432000}},{"externalId":"demo-abnb-0003@airbnb.example","propiedad":"Casa del Mar (demo)","unidad":"Depto 1","canal":"airbnb","desde":9,"noches":3,"origen":"ical","dtstamp":"2026-01-01T12:00:00Z","huesped":null,"contacto":null,"financiero":null},{"externalId":"demo-abnb-0004@airbnb.example","propiedad":"Casa del Mar (demo)","unidad":"Depto 1","canal":"airbnb","desde":21,"noches":2,"origen":"ical","dtstamp":"2026-01-01T12:00:00Z","huesped":null,"contacto":null,"financiero":null},{"externalId":"demo-bkg-0001@booking.example","propiedad":"Casa del Mar (demo)","unidad":"Depto 1","canal":"booking","desde":0,"noches":2,"origen":"ical","dtstamp":"2026-01-01T12:00:00Z","huesped":null,"contacto":null,"financiero":null},{"externalId":"demo-bkg-0002@booking.example","propiedad":"Casa del Mar (demo)","unidad":"Depto 1","canal":"booking","desde":14,"noches":4,"origen":"ical","dtstamp":"2026-01-01T12:00:00Z","huesped":null,"contacto":null,"financiero":null},{"externalId":"demo-vrbo-0001@vrbo.example","propiedad":"Loft Centro (demo)","unidad":"Loft A","canal":"vrbo","desde":-5,"noches":3,"origen":"ical","dtstamp":"2026-01-01T12:00:00Z","huesped":null,"contacto":null,"financiero":{"brutoCentavos":360000,"yaNeto":false,"comisionCanalBasisPoints":800,"comisionCanalFuente":"Demo: valor ilustrativo de la cuenta demo, no es la tarifa oficial del canal","comisionCanalCentavos":28800,"comisionGestorBasisPoints":2000,"comisionGestorCentavos":66240,"montoRecibidoCentavos":331200,"gastosCentavos":0,"netoCentavos":264960}},{"externalId":"demo-vrbo-0002@vrbo.example","propiedad":"Loft Centro (demo)","unidad":"Loft A","canal":"vrbo","desde":3,"noches":3,"origen":"ical","dtstamp":"2026-01-01T12:00:00Z","huesped":null,"contacto":null,"financiero":null},{"externalId":"demo-dir-d1","propiedad":"Casa del Mar (demo)","unidad":"Depto 1","canal":"manual","desde":-30,"noches":5,"origen":"directa","dtstamp":null,"huesped":"Diego Demo","contacto":"+52 00 0000 1000","financiero":{"brutoCentavos":900000,"yaNeto":true,"comisionCanalBasisPoints":0,"comisionCanalFuente":"Demo: valor ilustrativo de la cuenta demo, no es la tarifa oficial del canal","comisionCanalCentavos":0,"comisionGestorBasisPoints":2000,"comisionGestorCentavos":180000,"montoRecibidoCentavos":900000,"gastosCentavos":45000,"netoCentavos":675000}},{"externalId":"demo-dir-d2","propiedad":"Casa del Mar (demo)","unidad":"Depto 1","canal":"manual","desde":4,"noches":3,"origen":"directa","dtstamp":null,"huesped":"Elena Demo","contacto":"+52 00 0000 1001","financiero":null},{"externalId":"demo-dir-d3","propiedad":"Casa del Mar (demo)","unidad":"Depto 2","canal":"manual","desde":-7,"noches":3,"origen":"directa","dtstamp":null,"huesped":"Fabian Demo","contacto":"+52 00 0000 1002","financiero":{"brutoCentavos":495000,"yaNeto":true,"comisionCanalBasisPoints":0,"comisionCanalFuente":"Demo: valor ilustrativo de la cuenta demo, no es la tarifa oficial del canal","comisionCanalCentavos":0,"comisionGestorBasisPoints":2000,"comisionGestorCentavos":99000,"montoRecibidoCentavos":495000,"gastosCentavos":45000,"netoCentavos":351000}},{"externalId":"demo-dir-d4","propiedad":"Casa del Mar (demo)","unidad":"Depto 2","canal":"manual","desde":2,"noches":4,"origen":"directa","dtstamp":null,"huesped":"Gabriela Demo","contacto":"+52 00 0000 1003","financiero":null},{"externalId":"demo-dir-d5","propiedad":"Casa del Mar (demo)","unidad":"Depto 2","canal":"manual","desde":10,"noches":3,"origen":"directa","dtstamp":null,"huesped":"Hugo Demo","contacto":"+52 00 0000 1004","financiero":null},{"externalId":"demo-dir-d6","propiedad":"Casa del Mar (demo)","unidad":"Depto 2","canal":"manual","desde":-20,"noches":3,"origen":"directa","dtstamp":null,"huesped":"Irene Demo","contacto":"+52 00 0000 1005","financiero":{"brutoCentavos":495000,"yaNeto":true,"comisionCanalBasisPoints":0,"comisionCanalFuente":"Demo: valor ilustrativo de la cuenta demo, no es la tarifa oficial del canal","comisionCanalCentavos":0,"comisionGestorBasisPoints":2000,"comisionGestorCentavos":99000,"montoRecibidoCentavos":495000,"gastosCentavos":0,"netoCentavos":396000}},{"externalId":"demo-dir-d7","propiedad":"Loft Centro (demo)","unidad":"Loft A","canal":"manual","desde":8,"noches":2,"origen":"directa","dtstamp":null,"huesped":"Jorge Demo","contacto":"+52 00 0000 1006","financiero":null},{"externalId":"demo-dir-d8","propiedad":"Loft Centro (demo)","unidad":"Loft A","canal":"manual","desde":-12,"noches":3,"origen":"directa","dtstamp":null,"huesped":"Karla Demo","contacto":"+52 00 0000 1007","financiero":{"brutoCentavos":360000,"yaNeto":true,"comisionCanalBasisPoints":0,"comisionCanalFuente":"Demo: valor ilustrativo de la cuenta demo, no es la tarifa oficial del canal","comisionCanalCentavos":0,"comisionGestorBasisPoints":2000,"comisionGestorCentavos":72000,"montoRecibidoCentavos":360000,"gastosCentavos":35000,"netoCentavos":253000}},{"externalId":"demo-dir-d9","propiedad":"Villa Los Pinos (demo)","unidad":"Villa","canal":"manual","desde":-9,"noches":5,"origen":"directa","dtstamp":null,"huesped":"Luis Demo","contacto":"+52 00 0000 1008","financiero":{"brutoCentavos":1750000,"yaNeto":true,"comisionCanalBasisPoints":0,"comisionCanalFuente":"Demo: valor ilustrativo de la cuenta demo, no es la tarifa oficial del canal","comisionCanalCentavos":0,"comisionGestorBasisPoints":2000,"comisionGestorCentavos":350000,"montoRecibidoCentavos":1750000,"gastosCentavos":80000,"netoCentavos":1320000}},{"externalId":"demo-dir-d10","propiedad":"Villa Los Pinos (demo)","unidad":"Villa","canal":"manual","desde":1,"noches":4,"origen":"directa","dtstamp":null,"huesped":"Marta Demo","contacto":"+52 00 0000 1009","financiero":null},{"externalId":"demo-dir-d11","propiedad":"Villa Los Pinos (demo)","unidad":"Villa","canal":"manual","desde":15,"noches":5,"origen":"directa","dtstamp":null,"huesped":"Nico Demo","contacto":"+52 00 0000 1010","financiero":null},{"externalId":"demo-dir-d12","propiedad":"Villa Los Pinos (demo)","unidad":"Cabaña","canal":"manual","desde":-6,"noches":4,"origen":"directa","dtstamp":null,"huesped":"Olga Demo","contacto":"+52 00 0000 1011","financiero":{"brutoCentavos":560000,"yaNeto":true,"comisionCanalBasisPoints":0,"comisionCanalFuente":"Demo: valor ilustrativo de la cuenta demo, no es la tarifa oficial del canal","comisionCanalCentavos":0,"comisionGestorBasisPoints":2000,"comisionGestorCentavos":112000,"montoRecibidoCentavos":560000,"gastosCentavos":30000,"netoCentavos":418000}},{"externalId":"demo-dir-d13","propiedad":"Villa Los Pinos (demo)","unidad":"Cabaña","canal":"manual","desde":6,"noches":2,"origen":"directa","dtstamp":null,"huesped":"Pablo Demo","contacto":"+52 00 0000 1012","financiero":null}],"bloqueos":[{"externalId":"demo-blq-b1","propiedad":"Casa del Mar (demo)","unidad":"Depto 1","razon":"MANTENIMIENTO","desde":10,"noches":1}],"conflicto":{"propiedad":"Casa del Mar (demo)","unidad":"Depto 1","reservaExternalId":"demo-abnb-0003@airbnb.example","bloqueoExternalId":"demo-blq-b1"},"tareas":[{"propiedad":"Casa del Mar (demo)","unidad":"Depto 1","tipo":"limpieza","estado":"completada","prioridad":"media","programadaPara":-11,"slaHoras":null,"deReserva":"demo-abnb-0001@airbnb.example","asignadaAlOwner":true,"checklist":["Cambiar sábanas","Limpiar baños","Reponer amenidades"],"deReservaExternalId":"demo-abnb-0001@airbnb.example"},{"propiedad":"Casa del Mar (demo)","unidad":"Depto 1","tipo":"limpieza","estado":"pendiente","prioridad":"alta","programadaPara":0,"slaHoras":-3,"deReserva":"demo-abnb-0002@airbnb.example","asignadaAlOwner":false,"checklist":["Cambiar sábanas","Limpiar baños","Reponer amenidades"],"deReservaExternalId":"demo-abnb-0002@airbnb.example"},{"propiedad":"Casa del Mar (demo)","unidad":"Depto 2","tipo":"limpieza","estado":"asignada","prioridad":"media","programadaPara":1,"slaHoras":20,"deReserva":null,"asignadaAlOwner":true,"checklist":["Cambiar sábanas","Limpiar cocina"],"deReservaExternalId":null},{"propiedad":"Loft Centro (demo)","unidad":"Loft A","tipo":"inspeccion","estado":"en_progreso","prioridad":"baja","programadaPara":0,"slaHoras":30,"deReserva":null,"asignadaAlOwner":true,"checklist":["Revisar aire acondicionado","Revisar cerradura"],"deReservaExternalId":null},{"propiedad":"Villa Los Pinos (demo)","unidad":"Villa","tipo":"mantenimiento","estado":"pendiente","prioridad":"media","programadaPara":3,"slaHoras":72,"deReserva":null,"asignadaAlOwner":false,"checklist":["Revisar bomba de la alberca"],"deReservaExternalId":null}],"incidencias":[{"propiedad":"Villa Los Pinos (demo)","unidad":"Villa","severidad":"moderada","titulo":"Gotera en la terraza (demo)","descripcion":"Incidencia ficticia de la cuenta demo: una gotera en la terraza que no impide hospedar."}],"plantillas":[{"evento":"confirmacion","cuerpo":"Hola {{huesped}}, tu reserva en {{propiedad}} ({{unidad}}) del {{fecha_check_in}} al {{fecha_check_out}} está confirmada. ¡Gracias!","aprobada":true},{"evento":"pre_llegada","cuerpo":"Hola {{huesped}}, te esperamos en {{propiedad}} el {{fecha_check_in}}. Cualquier duda, escríbenos por aquí.","aprobada":true},{"evento":"check_in","cuerpo":"Bienvenido {{huesped}} a {{unidad}}. Que disfrutes tus {{noches}} noches.","aprobada":false},{"evento":"check_out","cuerpo":"Hola {{huesped}}, recuerda que tu salida de {{unidad}} es el {{fecha_check_out}}.","aprobada":false},{"evento":"resena","cuerpo":"Gracias por hospedarte en {{propiedad}}, {{huesped}}. ¿Nos dejas tu reseña?","aprobada":false}],"conversaciones":[{"propiedad":"Casa del Mar (demo)","unidad":"Depto 1","canal":"airbnb","reservaExternalId":"demo-abnb-0003@airbnb.example","huesped":"Quino Demo","mensajeEntrante":"Hola, ¿se puede hacer check-in más temprano el día de llegada?","borradorPendiente":"Hola Quino, con gusto lo revisamos: el check-in estándar es a las 15:00 y confirmamos si el depto está listo antes. Te avisamos."},{"propiedad":"Loft Centro (demo)","unidad":"Loft A","canal":"vrbo","reservaExternalId":"demo-vrbo-0002@vrbo.example","huesped":"Rosa Demo","mensajeEntrante":"¿Tienen estacionamiento para un coche?","borradorPendiente":"Hola Rosa, el loft cuenta con un lugar de estacionamiento. Si necesitas otro, te recomendamos opciones cercanas."}],"reglasComision":[{"canal":"airbnb","yaNeto":true,"bps":0},{"canal":"booking","yaNeto":false,"bps":1500},{"canal":"vrbo","yaNeto":false,"bps":800},{"canal":"manual","yaNeto":true,"bps":0}]}$rd$::jsonb;
  v_user uuid;
  v_org uuid;
  v_vertical text;
  v_prop uuid;
  v_zona text;
  v_hoy date;
  v_unidad uuid;
  v_owner uuid;
  v_canal uuid;
  v_oc uuid;
  v_oc_b uuid;
  v_guest uuid;
  v_rf uuid;
  v_conv uuid;
  v_msg uuid;
  v_tarea uuid;
  r jsonb;
  x jsonb;
begin
  select id into v_user from core.staff_user where lower(email) = 'duena@example.test';
  if v_user is null then
    raise exception 'seed-rentas: no existe un usuario de staff con el correo indicado (--owner-email); el seed no crea credenciales.';
  end if;

  -- 1) organizacion demo (slug demo-...): solo se crea o se actualiza una organizacion de rentas; cualquier otra con ese slug aborta.
  select id, vertical into v_org, v_vertical from core.organization where slug = v->'organizacion'->>'slug';
  if v_org is not null then
    if v_vertical <> 'rentas' then
      raise exception 'seed-rentas: el slug % ya existe y no es de rentas; no se toca.', v->'organizacion'->>'slug';
    end if;
    update core.organization set name = v->'organizacion'->>'nombre' where id = v_org;
  else
    insert into core.organization (vertical, name, slug) values ('rentas', v->'organizacion'->>'nombre', v->'organizacion'->>'slug') returning id into v_org;
  end if;
  -- El trigger de organization_perfil (027) siembra las 4 reglas de comision SUGERIDAS de la organizacion.
  insert into rentas.organization_perfil (organization_id, tipo) values (v_org, 'empresa_gestora') on conflict (organization_id) do nothing;
  insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role)
    values (v_user, v_org, null, 'owner', 'admin_gestora')
    on conflict do nothing;

  -- 2) propietarios (por organizacion + correo)
  for r in select * from jsonb_array_elements(v->'propietarios') loop
    select o.id into v_owner from rentas.owner o join rentas.owner_organization oo on oo.owner_id = o.id
      where oo.organization_id = v_org and lower(o.email) = lower(r->>'email');
    if v_owner is null then
      insert into rentas.owner (name, email) values (r->>'nombre', r->>'email') returning id into v_owner;
      insert into rentas.owner_organization (owner_id, organization_id) values (v_owner, v_org);
    end if;
  end loop;

  -- 3) propiedades, configuracion, politica de acceso, unidades, tarifas
  for r in select * from jsonb_array_elements(v->'propiedades') loop
    select id into v_prop from core.property where organization_id = v_org and name = r->>'nombre';
    if v_prop is null then
      insert into core.property (organization_id, vertical, name, status) values (v_org, 'rentas', r->>'nombre', 'active') returning id into v_prop;
    end if;
    insert into rentas.property_config (property_id, organization_id, zona_horaria, moneda) values (v_prop, v_org, r->>'zonaHoraria', 'MXN')
      on conflict (property_id) do nothing;
    if (r->>'accesoActivo')::boolean then
      insert into rentas.acceso_politica (property_id, organization_id, activo, updated_by) values (v_prop, v_org, true, v_user)
        on conflict (property_id) do nothing;
    end if;
    select zona_horaria into v_zona from rentas.property_config where property_id = v_prop;
    v_hoy := (now() at time zone v_zona)::date;
    for x in select * from jsonb_array_elements(r->'unidades') loop
      select o.id into v_owner from rentas.owner o join rentas.owner_organization oo on oo.owner_id = o.id
        where oo.organization_id = v_org and lower(o.email) = lower((select p->>'email' from jsonb_array_elements(v->'propietarios') p where p->>'clave' = x->>'propietario'));
      select id into v_unidad from rentas.unidad where property_id = v_prop and name = x->>'nombre';
      if v_unidad is null then
        insert into rentas.unidad (organization_id, property_id, owner_id, name, duracion_minima_noches)
          values (v_org, v_prop, v_owner, x->>'nombre', (x->>'duracionMinimaNoches')::int) returning id into v_unidad;
      end if;
      if not exists (select 1 from rentas.tarifa_base where unidad_id = v_unidad) then
        insert into rentas.tarifa_base (organization_id, property_id, unidad_id, precio_noche_centavos, moneda, vigente_desde, creado_por)
          values (v_org, v_prop, v_unidad, (x->>'tarifaBaseCentavos')::bigint, 'MXN', v_hoy - 90, v_user);
      end if;
      if x->'temporada' is not null and x->'temporada' <> 'null'::jsonb
         and not exists (select 1 from rentas.tarifa_temporada where unidad_id = v_unidad and nombre = x->'temporada'->>'nombre') then
        insert into rentas.tarifa_temporada (organization_id, property_id, unidad_id, nombre, fecha_inicio, fecha_fin, precio_noche_centavos, moneda, creado_por)
          values (v_org, v_prop, v_unidad, x->'temporada'->>'nombre', v_hoy + (x->'temporada'->>'desde')::int, v_hoy + (x->'temporada'->>'hasta')::int, (x->'temporada'->>'precioCentavos')::bigint, 'MXN', v_user);
      end if;
    end loop;
  end loop;

  -- 4) reglas de comision: confirma las SUGERIDAS (fuente default_sugerido...) con valores de demo; una regla ya editada no se pisa.
  update rentas.regla_comision_canal rc
    set ya_neto_de_comision = (rg->>'yaNeto')::boolean, comision_basis_points = (rg->>'bps')::int, fuente = 'Demo: valor ilustrativo de la cuenta demo, no es la tarifa oficial del canal'
    from jsonb_array_elements(v->'reglasComision') rg, rentas.canal c
    where c.codigo = rg->>'canal' and rc.organization_id = v_org and rc.canal_id = c.id and rc.property_id is null and rc.fuente like 'default\_sugerido%';
  insert into rentas.regla_comision_canal (organization_id, property_id, canal_id, ya_neto_de_comision, comision_basis_points, fuente)
    select v_org, null, c.id, (rg->>'yaNeto')::boolean, (rg->>'bps')::int, 'Demo: valor ilustrativo de la cuenta demo, no es la tarifa oficial del canal'
    from jsonb_array_elements(v->'reglasComision') rg join rentas.canal c on c.codigo = rg->>'canal'
    where not exists (select 1 from rentas.regla_comision_canal q where q.organization_id = v_org and q.canal_id = c.id and q.property_id is null);

  -- 5) feeds iCal (por unidad + canal). Las URLs son .invalid: la demo no consulta ningun calendario real.
  for r in select * from jsonb_array_elements(v->'feeds') loop
    select p.id, pc.zona_horaria into v_prop, v_zona from core.property p join rentas.property_config pc on pc.property_id = p.id where p.organization_id = v_org and p.name = r->>'propiedad';
    select id into v_unidad from rentas.unidad where property_id = v_prop and name = r->>'unidad';
    select id into v_canal from rentas.canal where codigo = r->>'canal';
    insert into rentas.canal_feed_externo (organization_id, property_id, unidad_id, canal_id, url_importacion, activo,
                                           ultima_sincronizacion_exitosa_en, en_cuarentena_desde, intentos_fallidos_consecutivos, motivo_cuarentena, ultimo_intento_en)
      values (v_org, v_prop, v_unidad, v_canal, r->>'url', true,
              case when r->>'estado' = 'ok' then now() - interval '25 minutes' else now() - interval '3 days' end,
              case when r->>'estado' = 'ok' then null else now() - interval '2 days' end,
              case when r->>'estado' = 'ok' then 0 else 6 end,
              case when r->>'estado' = 'ok' then null else 'El calendario dejo de responder (feed demo en cuarentena)' end,
              case when r->>'estado' = 'ok' then now() - interval '25 minutes' else now() - interval '2 days' end)
      on conflict (unidad_id, canal_id) do nothing;
  end loop;

  -- 6) reservas (importadas y directas) con su huesped minimo, evento importado y movimiento financiero
  for r in select * from jsonb_array_elements(v->'reservas') loop
    select p.id, pc.zona_horaria into v_prop, v_zona from core.property p join rentas.property_config pc on pc.property_id = p.id where p.organization_id = v_org and p.name = r->>'propiedad';
    v_hoy := (now() at time zone v_zona)::date;
    select id into v_unidad from rentas.unidad where property_id = v_prop and name = r->>'unidad';
    select id into v_canal from rentas.canal where codigo = r->>'canal';
    select id into v_oc from rentas.ocupacion where unidad_id = v_unidad and external_id = r->>'externalId';
    if v_oc is null then
      v_guest := null;
      if r->>'huesped' is not null then
        insert into rentas.guest_minimo (organization_id, property_id, nombre, contacto) values (v_org, v_prop, r->>'huesped', r->>'contacto') returning id into v_guest;
      end if;
      insert into rentas.ocupacion (organization_id, property_id, unidad_id, rango, capa, razon, canal_origen_id, external_id, estado, bloqueante, huesped_minimo_id)
        values (v_org, v_prop, v_unidad, daterange(v_hoy + (r->>'desde')::int, v_hoy + (r->>'desde')::int + (r->>'noches')::int, '[)'), 'reserva', 'RESERVA_CANAL', v_canal, r->>'externalId', 'confirmado', true, v_guest)
        returning id into v_oc;
      if r->>'origen' = 'ical' then
        insert into rentas.evento_canal_importado (organization_id, property_id, unidad_id, canal_id, uid_evento, sequence, dtstamp, hash_contenido, ocupacion_id, ultima_accion)
          values (v_org, v_prop, v_unidad, v_canal, r->>'externalId', 0, (r->>'dtstamp')::timestamptz,
                  encode(sha256(convert_to(v_unidad::text || '|' || (r->>'desde') || '|' || (r->>'noches') || '|RESERVA_CANAL', 'UTF8')), 'hex'), v_oc, 'aplicar')
          on conflict (unidad_id, canal_id, uid_evento) do nothing;
      end if;
    end if;
    if r->'financiero' is not null and r->'financiero' <> 'null'::jsonb then
      v_rf := null;
      insert into rentas.reserva_financiero (organization_id, property_id, ocupacion_id, moneda, monto_bruto_centavos, ya_neto_de_comision, comision_canal_basis_points, comision_canal_fuente,
                                             comision_canal_centavos, comision_gestor_basis_points, comision_gestor_base, comision_gestor_centavos, monto_recibido_centavos,
                                             gastos_centavos, impuestos_centavos, neto_centavos, created_by)
        values (v_org, v_prop, v_oc, 'MXN', (r->'financiero'->>'brutoCentavos')::bigint, (r->'financiero'->>'yaNeto')::boolean, (r->'financiero'->>'comisionCanalBasisPoints')::int,
                r->'financiero'->>'comisionCanalFuente', (r->'financiero'->>'comisionCanalCentavos')::bigint, (r->'financiero'->>'comisionGestorBasisPoints')::int, 'neto_de_canal',
                (r->'financiero'->>'comisionGestorCentavos')::bigint, (r->'financiero'->>'montoRecibidoCentavos')::bigint, (r->'financiero'->>'gastosCentavos')::bigint, 0,
                (r->'financiero'->>'netoCentavos')::bigint, v_user)
        on conflict (ocupacion_id) do nothing
        returning id into v_rf;
      if v_rf is not null and (r->'financiero'->>'gastosCentavos')::bigint > 0 then
        insert into rentas.linea_gasto (reserva_financiero_id, tipo, descripcion, monto_centavos, creado_por)
          values (v_rf, 'limpieza', 'Limpieza de salida (demo)', (r->'financiero'->>'gastosCentavos')::bigint, v_user);
      end if;
    end if;
  end loop;

  -- 7) bloqueos y el conflicto abierto (la reserva importada cruza con un bloqueo de mantenimiento)
  for r in select * from jsonb_array_elements(v->'bloqueos') loop
    select p.id, pc.zona_horaria into v_prop, v_zona from core.property p join rentas.property_config pc on pc.property_id = p.id where p.organization_id = v_org and p.name = r->>'propiedad';
    v_hoy := (now() at time zone v_zona)::date;
    select id into v_unidad from rentas.unidad where property_id = v_prop and name = r->>'unidad';
    if not exists (select 1 from rentas.ocupacion where unidad_id = v_unidad and external_id = r->>'externalId') then
      insert into rentas.ocupacion (organization_id, property_id, unidad_id, rango, capa, razon, external_id, estado, bloqueante)
        values (v_org, v_prop, v_unidad, daterange(v_hoy + (r->>'desde')::int, v_hoy + (r->>'desde')::int + (r->>'noches')::int, '[)'), 'bloqueo', r->>'razon', r->>'externalId', 'confirmado', true);
    end if;
  end loop;
  x := v->'conflicto';
  select p.id into v_prop from core.property p where p.organization_id = v_org and p.name = x->>'propiedad';
  select id into v_unidad from rentas.unidad where property_id = v_prop and name = x->>'unidad';
  select id into v_oc from rentas.ocupacion where unidad_id = v_unidad and external_id = x->>'reservaExternalId';
  select id into v_oc_b from rentas.ocupacion where unidad_id = v_unidad and external_id = x->>'bloqueoExternalId';
  if not exists (select 1 from rentas.conflicto_calendario where ocupacion_a_id = v_oc and ocupacion_b_id = v_oc_b) then
    insert into rentas.conflicto_calendario (organization_id, property_id, unidad_id, ocupacion_a_id, ocupacion_b_id, tipo)
      values (v_org, v_prop, v_unidad, v_oc, v_oc_b, 'capa_cruzada');
  end if;

  -- 8) tareas de limpieza/inspeccion/mantenimiento con su checklist (solo si la organizacion demo aun no tiene)
  if not exists (select 1 from rentas.tarea_operativa where organization_id = v_org) then
    for r in select * from jsonb_array_elements(v->'tareas') loop
      select p.id, pc.zona_horaria into v_prop, v_zona from core.property p join rentas.property_config pc on pc.property_id = p.id where p.organization_id = v_org and p.name = r->>'propiedad';
      v_hoy := (now() at time zone v_zona)::date;
      select id into v_unidad from rentas.unidad where property_id = v_prop and name = r->>'unidad';
      v_oc := null;
      if r->>'deReservaExternalId' is not null then
        select id into v_oc from rentas.ocupacion where unidad_id = v_unidad and external_id = r->>'deReservaExternalId';
      end if;
      insert into rentas.tarea_operativa (organization_id, property_id, unidad_id, ocupacion_unidad_id, tipo, estado, prioridad, asignado_a, programada_para, sla_vence_en, completada_en)
        values (v_org, v_prop, v_unidad, v_oc, r->>'tipo', r->>'estado', r->>'prioridad',
                case when (r->>'asignadaAlOwner')::boolean then v_user else null end,
                v_hoy + (r->>'programadaPara')::int,
                case when r->>'slaHoras' is null then null else now() + make_interval(hours => (r->>'slaHoras')::int) end,
                case when r->>'estado' = 'completada' then now() - interval '1 day' else null end)
        returning id into v_tarea;
      insert into rentas.checklist_item_tarea (tarea_id, descripcion, orden, completado, completado_en, completado_por)
        select v_tarea, c.descripcion, c.orden::int - 1, r->>'estado' = 'completada', case when r->>'estado' = 'completada' then now() - interval '1 day' else null end,
               case when r->>'estado' = 'completada' then v_user else null end
        from jsonb_array_elements_text(r->'checklist') with ordinality as c(descripcion, orden);
    end loop;
  end if;

  -- 9) incidencia (solo si la organizacion demo aun no tiene)
  if not exists (select 1 from rentas.incidencia_mantenimiento where organization_id = v_org) then
    for r in select * from jsonb_array_elements(v->'incidencias') loop
      select id into v_prop from core.property where organization_id = v_org and name = r->>'propiedad';
      select id into v_unidad from rentas.unidad where property_id = v_prop and name = r->>'unidad';
      insert into rentas.incidencia_mantenimiento (organization_id, property_id, unidad_id, severidad, titulo, descripcion, estado, reportado_por)
        values (v_org, v_prop, v_unidad, r->>'severidad', r->>'titulo', r->>'descripcion', 'abierta', v_user);
    end loop;
  end if;

  -- 10) plantillas de mensajeria (por evento + idioma; una plantilla ya editada o aprobada por el usuario no se pisa)
  insert into rentas.plantilla_mensaje (organization_id, evento, idioma, canal_codigo, cuerpo, aprobada_por_tenant, activa)
    select v_org, p->>'evento', 'es', null, p->>'cuerpo', (p->>'aprobada')::boolean, true
    from jsonb_array_elements(v->'plantillas') p
    where not exists (select 1 from rentas.plantilla_mensaje q where q.organization_id = v_org and q.evento = p->>'evento' and q.idioma = 'es' and q.canal_codigo is null);

  -- 11) conversaciones con su borrador pendiente de aprobacion (solo si la organizacion demo aun no tiene)
  if not exists (select 1 from rentas.conversacion where organization_id = v_org) then
    for r in select * from jsonb_array_elements(v->'conversaciones') loop
      select id into v_prop from core.property where organization_id = v_org and name = r->>'propiedad';
      select id into v_unidad from rentas.unidad where property_id = v_prop and name = r->>'unidad';
      select id into v_oc from rentas.ocupacion where unidad_id = v_unidad and external_id = r->>'reservaExternalId';
      insert into rentas.conversacion (organization_id, property_id, unidad_id, canal_codigo, ocupacion_id, propiedad_nombre, huesped_nombre, fecha_check_in, fecha_check_out, reserva_confirmada)
        select v_org, v_prop, v_unidad, r->>'canal', o.id, r->>'propiedad', r->>'huesped', lower(o.rango), upper(o.rango), true from rentas.ocupacion o where o.id = v_oc
        returning id into v_conv;
      insert into rentas.mensaje (conversacion_id, direccion, origen, texto) values (v_conv, 'entrante', 'canal', r->>'mensajeEntrante') returning id into v_msg;
      insert into rentas.borrador_mensaje (conversacion_id, mensaje_entrante_id, canal_codigo, texto, estado, generado_por)
        values (v_conv, v_msg, r->>'canal', r->>'borradorPendiente', 'pendiente_aprobacion', 'agente_llm');
    end loop;
  end if;
end
$seed_fn$;
create or replace function public.seed_rentas_demo_sin_duena() returns void language plpgsql as $seed_fn$
declare
  v jsonb := $rd${"seedVersion":"rentas-demo-1","organizacion":{"slug":"demo-rentas-gestora","nombre":"Gestora Demo Rentas (demo)"},"propietarios":[{"clave":"ana","nombre":"Ana Demo Propietaria","email":"ana.propietaria@example.test"},{"clave":"beto","nombre":"Beto Demo Propietario","email":"beto.propietario@example.test"},{"clave":"carla","nombre":"Carla Demo Propietaria","email":"carla.propietaria@example.test"}],"propiedades":[{"nombre":"Casa del Mar (demo)","zonaHoraria":"America/Cancun","accesoActivo":true,"unidades":[{"nombre":"Depto 1","propietario":"ana","duracionMinimaNoches":2,"tarifaBaseCentavos":180000,"temporada":{"nombre":"Temporada alta demo","desde":20,"hasta":40,"precioCentavos":240000}},{"nombre":"Depto 2","propietario":"ana","duracionMinimaNoches":2,"tarifaBaseCentavos":165000,"temporada":null}]},{"nombre":"Loft Centro (demo)","zonaHoraria":"America/Mexico_City","accesoActivo":false,"unidades":[{"nombre":"Loft A","propietario":"beto","duracionMinimaNoches":1,"tarifaBaseCentavos":120000,"temporada":null}]},{"nombre":"Villa Los Pinos (demo)","zonaHoraria":"America/Merida","accesoActivo":false,"unidades":[{"nombre":"Villa","propietario":"carla","duracionMinimaNoches":3,"tarifaBaseCentavos":350000,"temporada":null},{"nombre":"Cabaña","propietario":"carla","duracionMinimaNoches":2,"tarifaBaseCentavos":140000,"temporada":null}]}],"feeds":[{"propiedad":"Casa del Mar (demo)","unidad":"Depto 1","canal":"airbnb","url":"https://calendarios.demo.invalid/ical/airbnb-casa-del-mar-depto-1.ics","estado":"ok"},{"propiedad":"Casa del Mar (demo)","unidad":"Depto 1","canal":"booking","url":"https://calendarios.demo.invalid/ical/booking-casa-del-mar-depto-1.ics","estado":"ok"},{"propiedad":"Loft Centro (demo)","unidad":"Loft A","canal":"vrbo","url":"https://calendarios.demo.invalid/ical/vrbo-loft-centro-loft-a.ics","estado":"cuarentena"}],"reservas":[{"externalId":"demo-abnb-0001@airbnb.example","propiedad":"Casa del Mar (demo)","unidad":"Depto 1","canal":"airbnb","desde":-14,"noches":3,"origen":"ical","dtstamp":"2026-01-01T12:00:00Z","huesped":null,"contacto":null,"financiero":{"brutoCentavos":540000,"yaNeto":true,"comisionCanalBasisPoints":0,"comisionCanalFuente":"Demo: valor ilustrativo de la cuenta demo, no es la tarifa oficial del canal","comisionCanalCentavos":0,"comisionGestorBasisPoints":2000,"comisionGestorCentavos":108000,"montoRecibidoCentavos":540000,"gastosCentavos":0,"netoCentavos":432000}},{"externalId":"demo-abnb-0002@airbnb.example","propiedad":"Casa del Mar (demo)","unidad":"Depto 1","canal":"airbnb","desde":-3,"noches":3,"origen":"ical","dtstamp":"2026-01-01T12:00:00Z","huesped":null,"contacto":null,"financiero":{"brutoCentavos":540000,"yaNeto":true,"comisionCanalBasisPoints":0,"comisionCanalFuente":"Demo: valor ilustrativo de la cuenta demo, no es la tarifa oficial del canal","comisionCanalCentavos":0,"comisionGestorBasisPoints":2000,"comisionGestorCentavos":108000,"montoRecibidoCentavos":540000,"gastosCentavos":0,"netoCentavos":432000}},{"externalId":"demo-abnb-0003@airbnb.example","propiedad":"Casa del Mar (demo)","unidad":"Depto 1","canal":"airbnb","desde":9,"noches":3,"origen":"ical","dtstamp":"2026-01-01T12:00:00Z","huesped":null,"contacto":null,"financiero":null},{"externalId":"demo-abnb-0004@airbnb.example","propiedad":"Casa del Mar (demo)","unidad":"Depto 1","canal":"airbnb","desde":21,"noches":2,"origen":"ical","dtstamp":"2026-01-01T12:00:00Z","huesped":null,"contacto":null,"financiero":null},{"externalId":"demo-bkg-0001@booking.example","propiedad":"Casa del Mar (demo)","unidad":"Depto 1","canal":"booking","desde":0,"noches":2,"origen":"ical","dtstamp":"2026-01-01T12:00:00Z","huesped":null,"contacto":null,"financiero":null},{"externalId":"demo-bkg-0002@booking.example","propiedad":"Casa del Mar (demo)","unidad":"Depto 1","canal":"booking","desde":14,"noches":4,"origen":"ical","dtstamp":"2026-01-01T12:00:00Z","huesped":null,"contacto":null,"financiero":null},{"externalId":"demo-vrbo-0001@vrbo.example","propiedad":"Loft Centro (demo)","unidad":"Loft A","canal":"vrbo","desde":-5,"noches":3,"origen":"ical","dtstamp":"2026-01-01T12:00:00Z","huesped":null,"contacto":null,"financiero":{"brutoCentavos":360000,"yaNeto":false,"comisionCanalBasisPoints":800,"comisionCanalFuente":"Demo: valor ilustrativo de la cuenta demo, no es la tarifa oficial del canal","comisionCanalCentavos":28800,"comisionGestorBasisPoints":2000,"comisionGestorCentavos":66240,"montoRecibidoCentavos":331200,"gastosCentavos":0,"netoCentavos":264960}},{"externalId":"demo-vrbo-0002@vrbo.example","propiedad":"Loft Centro (demo)","unidad":"Loft A","canal":"vrbo","desde":3,"noches":3,"origen":"ical","dtstamp":"2026-01-01T12:00:00Z","huesped":null,"contacto":null,"financiero":null},{"externalId":"demo-dir-d1","propiedad":"Casa del Mar (demo)","unidad":"Depto 1","canal":"manual","desde":-30,"noches":5,"origen":"directa","dtstamp":null,"huesped":"Diego Demo","contacto":"+52 00 0000 1000","financiero":{"brutoCentavos":900000,"yaNeto":true,"comisionCanalBasisPoints":0,"comisionCanalFuente":"Demo: valor ilustrativo de la cuenta demo, no es la tarifa oficial del canal","comisionCanalCentavos":0,"comisionGestorBasisPoints":2000,"comisionGestorCentavos":180000,"montoRecibidoCentavos":900000,"gastosCentavos":45000,"netoCentavos":675000}},{"externalId":"demo-dir-d2","propiedad":"Casa del Mar (demo)","unidad":"Depto 1","canal":"manual","desde":4,"noches":3,"origen":"directa","dtstamp":null,"huesped":"Elena Demo","contacto":"+52 00 0000 1001","financiero":null},{"externalId":"demo-dir-d3","propiedad":"Casa del Mar (demo)","unidad":"Depto 2","canal":"manual","desde":-7,"noches":3,"origen":"directa","dtstamp":null,"huesped":"Fabian Demo","contacto":"+52 00 0000 1002","financiero":{"brutoCentavos":495000,"yaNeto":true,"comisionCanalBasisPoints":0,"comisionCanalFuente":"Demo: valor ilustrativo de la cuenta demo, no es la tarifa oficial del canal","comisionCanalCentavos":0,"comisionGestorBasisPoints":2000,"comisionGestorCentavos":99000,"montoRecibidoCentavos":495000,"gastosCentavos":45000,"netoCentavos":351000}},{"externalId":"demo-dir-d4","propiedad":"Casa del Mar (demo)","unidad":"Depto 2","canal":"manual","desde":2,"noches":4,"origen":"directa","dtstamp":null,"huesped":"Gabriela Demo","contacto":"+52 00 0000 1003","financiero":null},{"externalId":"demo-dir-d5","propiedad":"Casa del Mar (demo)","unidad":"Depto 2","canal":"manual","desde":10,"noches":3,"origen":"directa","dtstamp":null,"huesped":"Hugo Demo","contacto":"+52 00 0000 1004","financiero":null},{"externalId":"demo-dir-d6","propiedad":"Casa del Mar (demo)","unidad":"Depto 2","canal":"manual","desde":-20,"noches":3,"origen":"directa","dtstamp":null,"huesped":"Irene Demo","contacto":"+52 00 0000 1005","financiero":{"brutoCentavos":495000,"yaNeto":true,"comisionCanalBasisPoints":0,"comisionCanalFuente":"Demo: valor ilustrativo de la cuenta demo, no es la tarifa oficial del canal","comisionCanalCentavos":0,"comisionGestorBasisPoints":2000,"comisionGestorCentavos":99000,"montoRecibidoCentavos":495000,"gastosCentavos":0,"netoCentavos":396000}},{"externalId":"demo-dir-d7","propiedad":"Loft Centro (demo)","unidad":"Loft A","canal":"manual","desde":8,"noches":2,"origen":"directa","dtstamp":null,"huesped":"Jorge Demo","contacto":"+52 00 0000 1006","financiero":null},{"externalId":"demo-dir-d8","propiedad":"Loft Centro (demo)","unidad":"Loft A","canal":"manual","desde":-12,"noches":3,"origen":"directa","dtstamp":null,"huesped":"Karla Demo","contacto":"+52 00 0000 1007","financiero":{"brutoCentavos":360000,"yaNeto":true,"comisionCanalBasisPoints":0,"comisionCanalFuente":"Demo: valor ilustrativo de la cuenta demo, no es la tarifa oficial del canal","comisionCanalCentavos":0,"comisionGestorBasisPoints":2000,"comisionGestorCentavos":72000,"montoRecibidoCentavos":360000,"gastosCentavos":35000,"netoCentavos":253000}},{"externalId":"demo-dir-d9","propiedad":"Villa Los Pinos (demo)","unidad":"Villa","canal":"manual","desde":-9,"noches":5,"origen":"directa","dtstamp":null,"huesped":"Luis Demo","contacto":"+52 00 0000 1008","financiero":{"brutoCentavos":1750000,"yaNeto":true,"comisionCanalBasisPoints":0,"comisionCanalFuente":"Demo: valor ilustrativo de la cuenta demo, no es la tarifa oficial del canal","comisionCanalCentavos":0,"comisionGestorBasisPoints":2000,"comisionGestorCentavos":350000,"montoRecibidoCentavos":1750000,"gastosCentavos":80000,"netoCentavos":1320000}},{"externalId":"demo-dir-d10","propiedad":"Villa Los Pinos (demo)","unidad":"Villa","canal":"manual","desde":1,"noches":4,"origen":"directa","dtstamp":null,"huesped":"Marta Demo","contacto":"+52 00 0000 1009","financiero":null},{"externalId":"demo-dir-d11","propiedad":"Villa Los Pinos (demo)","unidad":"Villa","canal":"manual","desde":15,"noches":5,"origen":"directa","dtstamp":null,"huesped":"Nico Demo","contacto":"+52 00 0000 1010","financiero":null},{"externalId":"demo-dir-d12","propiedad":"Villa Los Pinos (demo)","unidad":"Cabaña","canal":"manual","desde":-6,"noches":4,"origen":"directa","dtstamp":null,"huesped":"Olga Demo","contacto":"+52 00 0000 1011","financiero":{"brutoCentavos":560000,"yaNeto":true,"comisionCanalBasisPoints":0,"comisionCanalFuente":"Demo: valor ilustrativo de la cuenta demo, no es la tarifa oficial del canal","comisionCanalCentavos":0,"comisionGestorBasisPoints":2000,"comisionGestorCentavos":112000,"montoRecibidoCentavos":560000,"gastosCentavos":30000,"netoCentavos":418000}},{"externalId":"demo-dir-d13","propiedad":"Villa Los Pinos (demo)","unidad":"Cabaña","canal":"manual","desde":6,"noches":2,"origen":"directa","dtstamp":null,"huesped":"Pablo Demo","contacto":"+52 00 0000 1012","financiero":null}],"bloqueos":[{"externalId":"demo-blq-b1","propiedad":"Casa del Mar (demo)","unidad":"Depto 1","razon":"MANTENIMIENTO","desde":10,"noches":1}],"conflicto":{"propiedad":"Casa del Mar (demo)","unidad":"Depto 1","reservaExternalId":"demo-abnb-0003@airbnb.example","bloqueoExternalId":"demo-blq-b1"},"tareas":[{"propiedad":"Casa del Mar (demo)","unidad":"Depto 1","tipo":"limpieza","estado":"completada","prioridad":"media","programadaPara":-11,"slaHoras":null,"deReserva":"demo-abnb-0001@airbnb.example","asignadaAlOwner":true,"checklist":["Cambiar sábanas","Limpiar baños","Reponer amenidades"],"deReservaExternalId":"demo-abnb-0001@airbnb.example"},{"propiedad":"Casa del Mar (demo)","unidad":"Depto 1","tipo":"limpieza","estado":"pendiente","prioridad":"alta","programadaPara":0,"slaHoras":-3,"deReserva":"demo-abnb-0002@airbnb.example","asignadaAlOwner":false,"checklist":["Cambiar sábanas","Limpiar baños","Reponer amenidades"],"deReservaExternalId":"demo-abnb-0002@airbnb.example"},{"propiedad":"Casa del Mar (demo)","unidad":"Depto 2","tipo":"limpieza","estado":"asignada","prioridad":"media","programadaPara":1,"slaHoras":20,"deReserva":null,"asignadaAlOwner":true,"checklist":["Cambiar sábanas","Limpiar cocina"],"deReservaExternalId":null},{"propiedad":"Loft Centro (demo)","unidad":"Loft A","tipo":"inspeccion","estado":"en_progreso","prioridad":"baja","programadaPara":0,"slaHoras":30,"deReserva":null,"asignadaAlOwner":true,"checklist":["Revisar aire acondicionado","Revisar cerradura"],"deReservaExternalId":null},{"propiedad":"Villa Los Pinos (demo)","unidad":"Villa","tipo":"mantenimiento","estado":"pendiente","prioridad":"media","programadaPara":3,"slaHoras":72,"deReserva":null,"asignadaAlOwner":false,"checklist":["Revisar bomba de la alberca"],"deReservaExternalId":null}],"incidencias":[{"propiedad":"Villa Los Pinos (demo)","unidad":"Villa","severidad":"moderada","titulo":"Gotera en la terraza (demo)","descripcion":"Incidencia ficticia de la cuenta demo: una gotera en la terraza que no impide hospedar."}],"plantillas":[{"evento":"confirmacion","cuerpo":"Hola {{huesped}}, tu reserva en {{propiedad}} ({{unidad}}) del {{fecha_check_in}} al {{fecha_check_out}} está confirmada. ¡Gracias!","aprobada":true},{"evento":"pre_llegada","cuerpo":"Hola {{huesped}}, te esperamos en {{propiedad}} el {{fecha_check_in}}. Cualquier duda, escríbenos por aquí.","aprobada":true},{"evento":"check_in","cuerpo":"Bienvenido {{huesped}} a {{unidad}}. Que disfrutes tus {{noches}} noches.","aprobada":false},{"evento":"check_out","cuerpo":"Hola {{huesped}}, recuerda que tu salida de {{unidad}} es el {{fecha_check_out}}.","aprobada":false},{"evento":"resena","cuerpo":"Gracias por hospedarte en {{propiedad}}, {{huesped}}. ¿Nos dejas tu reseña?","aprobada":false}],"conversaciones":[{"propiedad":"Casa del Mar (demo)","unidad":"Depto 1","canal":"airbnb","reservaExternalId":"demo-abnb-0003@airbnb.example","huesped":"Quino Demo","mensajeEntrante":"Hola, ¿se puede hacer check-in más temprano el día de llegada?","borradorPendiente":"Hola Quino, con gusto lo revisamos: el check-in estándar es a las 15:00 y confirmamos si el depto está listo antes. Te avisamos."},{"propiedad":"Loft Centro (demo)","unidad":"Loft A","canal":"vrbo","reservaExternalId":"demo-vrbo-0002@vrbo.example","huesped":"Rosa Demo","mensajeEntrante":"¿Tienen estacionamiento para un coche?","borradorPendiente":"Hola Rosa, el loft cuenta con un lugar de estacionamiento. Si necesitas otro, te recomendamos opciones cercanas."}],"reglasComision":[{"canal":"airbnb","yaNeto":true,"bps":0},{"canal":"booking","yaNeto":false,"bps":1500},{"canal":"vrbo","yaNeto":false,"bps":800},{"canal":"manual","yaNeto":true,"bps":0}]}$rd$::jsonb;
  v_user uuid;
  v_org uuid;
  v_vertical text;
  v_prop uuid;
  v_zona text;
  v_hoy date;
  v_unidad uuid;
  v_owner uuid;
  v_canal uuid;
  v_oc uuid;
  v_oc_b uuid;
  v_guest uuid;
  v_rf uuid;
  v_conv uuid;
  v_msg uuid;
  v_tarea uuid;
  r jsonb;
  x jsonb;
begin
  select id into v_user from core.staff_user where lower(email) = 'no-existe@example.test';
  if v_user is null then
    raise exception 'seed-rentas: no existe un usuario de staff con el correo indicado (--owner-email); el seed no crea credenciales.';
  end if;

  -- 1) organizacion demo (slug demo-...): solo se crea o se actualiza una organizacion de rentas; cualquier otra con ese slug aborta.
  select id, vertical into v_org, v_vertical from core.organization where slug = v->'organizacion'->>'slug';
  if v_org is not null then
    if v_vertical <> 'rentas' then
      raise exception 'seed-rentas: el slug % ya existe y no es de rentas; no se toca.', v->'organizacion'->>'slug';
    end if;
    update core.organization set name = v->'organizacion'->>'nombre' where id = v_org;
  else
    insert into core.organization (vertical, name, slug) values ('rentas', v->'organizacion'->>'nombre', v->'organizacion'->>'slug') returning id into v_org;
  end if;
  -- El trigger de organization_perfil (027) siembra las 4 reglas de comision SUGERIDAS de la organizacion.
  insert into rentas.organization_perfil (organization_id, tipo) values (v_org, 'empresa_gestora') on conflict (organization_id) do nothing;
  insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role)
    values (v_user, v_org, null, 'owner', 'admin_gestora')
    on conflict do nothing;

  -- 2) propietarios (por organizacion + correo)
  for r in select * from jsonb_array_elements(v->'propietarios') loop
    select o.id into v_owner from rentas.owner o join rentas.owner_organization oo on oo.owner_id = o.id
      where oo.organization_id = v_org and lower(o.email) = lower(r->>'email');
    if v_owner is null then
      insert into rentas.owner (name, email) values (r->>'nombre', r->>'email') returning id into v_owner;
      insert into rentas.owner_organization (owner_id, organization_id) values (v_owner, v_org);
    end if;
  end loop;

  -- 3) propiedades, configuracion, politica de acceso, unidades, tarifas
  for r in select * from jsonb_array_elements(v->'propiedades') loop
    select id into v_prop from core.property where organization_id = v_org and name = r->>'nombre';
    if v_prop is null then
      insert into core.property (organization_id, vertical, name, status) values (v_org, 'rentas', r->>'nombre', 'active') returning id into v_prop;
    end if;
    insert into rentas.property_config (property_id, organization_id, zona_horaria, moneda) values (v_prop, v_org, r->>'zonaHoraria', 'MXN')
      on conflict (property_id) do nothing;
    if (r->>'accesoActivo')::boolean then
      insert into rentas.acceso_politica (property_id, organization_id, activo, updated_by) values (v_prop, v_org, true, v_user)
        on conflict (property_id) do nothing;
    end if;
    select zona_horaria into v_zona from rentas.property_config where property_id = v_prop;
    v_hoy := (now() at time zone v_zona)::date;
    for x in select * from jsonb_array_elements(r->'unidades') loop
      select o.id into v_owner from rentas.owner o join rentas.owner_organization oo on oo.owner_id = o.id
        where oo.organization_id = v_org and lower(o.email) = lower((select p->>'email' from jsonb_array_elements(v->'propietarios') p where p->>'clave' = x->>'propietario'));
      select id into v_unidad from rentas.unidad where property_id = v_prop and name = x->>'nombre';
      if v_unidad is null then
        insert into rentas.unidad (organization_id, property_id, owner_id, name, duracion_minima_noches)
          values (v_org, v_prop, v_owner, x->>'nombre', (x->>'duracionMinimaNoches')::int) returning id into v_unidad;
      end if;
      if not exists (select 1 from rentas.tarifa_base where unidad_id = v_unidad) then
        insert into rentas.tarifa_base (organization_id, property_id, unidad_id, precio_noche_centavos, moneda, vigente_desde, creado_por)
          values (v_org, v_prop, v_unidad, (x->>'tarifaBaseCentavos')::bigint, 'MXN', v_hoy - 90, v_user);
      end if;
      if x->'temporada' is not null and x->'temporada' <> 'null'::jsonb
         and not exists (select 1 from rentas.tarifa_temporada where unidad_id = v_unidad and nombre = x->'temporada'->>'nombre') then
        insert into rentas.tarifa_temporada (organization_id, property_id, unidad_id, nombre, fecha_inicio, fecha_fin, precio_noche_centavos, moneda, creado_por)
          values (v_org, v_prop, v_unidad, x->'temporada'->>'nombre', v_hoy + (x->'temporada'->>'desde')::int, v_hoy + (x->'temporada'->>'hasta')::int, (x->'temporada'->>'precioCentavos')::bigint, 'MXN', v_user);
      end if;
    end loop;
  end loop;

  -- 4) reglas de comision: confirma las SUGERIDAS (fuente default_sugerido...) con valores de demo; una regla ya editada no se pisa.
  update rentas.regla_comision_canal rc
    set ya_neto_de_comision = (rg->>'yaNeto')::boolean, comision_basis_points = (rg->>'bps')::int, fuente = 'Demo: valor ilustrativo de la cuenta demo, no es la tarifa oficial del canal'
    from jsonb_array_elements(v->'reglasComision') rg, rentas.canal c
    where c.codigo = rg->>'canal' and rc.organization_id = v_org and rc.canal_id = c.id and rc.property_id is null and rc.fuente like 'default\_sugerido%';
  insert into rentas.regla_comision_canal (organization_id, property_id, canal_id, ya_neto_de_comision, comision_basis_points, fuente)
    select v_org, null, c.id, (rg->>'yaNeto')::boolean, (rg->>'bps')::int, 'Demo: valor ilustrativo de la cuenta demo, no es la tarifa oficial del canal'
    from jsonb_array_elements(v->'reglasComision') rg join rentas.canal c on c.codigo = rg->>'canal'
    where not exists (select 1 from rentas.regla_comision_canal q where q.organization_id = v_org and q.canal_id = c.id and q.property_id is null);

  -- 5) feeds iCal (por unidad + canal). Las URLs son .invalid: la demo no consulta ningun calendario real.
  for r in select * from jsonb_array_elements(v->'feeds') loop
    select p.id, pc.zona_horaria into v_prop, v_zona from core.property p join rentas.property_config pc on pc.property_id = p.id where p.organization_id = v_org and p.name = r->>'propiedad';
    select id into v_unidad from rentas.unidad where property_id = v_prop and name = r->>'unidad';
    select id into v_canal from rentas.canal where codigo = r->>'canal';
    insert into rentas.canal_feed_externo (organization_id, property_id, unidad_id, canal_id, url_importacion, activo,
                                           ultima_sincronizacion_exitosa_en, en_cuarentena_desde, intentos_fallidos_consecutivos, motivo_cuarentena, ultimo_intento_en)
      values (v_org, v_prop, v_unidad, v_canal, r->>'url', true,
              case when r->>'estado' = 'ok' then now() - interval '25 minutes' else now() - interval '3 days' end,
              case when r->>'estado' = 'ok' then null else now() - interval '2 days' end,
              case when r->>'estado' = 'ok' then 0 else 6 end,
              case when r->>'estado' = 'ok' then null else 'El calendario dejo de responder (feed demo en cuarentena)' end,
              case when r->>'estado' = 'ok' then now() - interval '25 minutes' else now() - interval '2 days' end)
      on conflict (unidad_id, canal_id) do nothing;
  end loop;

  -- 6) reservas (importadas y directas) con su huesped minimo, evento importado y movimiento financiero
  for r in select * from jsonb_array_elements(v->'reservas') loop
    select p.id, pc.zona_horaria into v_prop, v_zona from core.property p join rentas.property_config pc on pc.property_id = p.id where p.organization_id = v_org and p.name = r->>'propiedad';
    v_hoy := (now() at time zone v_zona)::date;
    select id into v_unidad from rentas.unidad where property_id = v_prop and name = r->>'unidad';
    select id into v_canal from rentas.canal where codigo = r->>'canal';
    select id into v_oc from rentas.ocupacion where unidad_id = v_unidad and external_id = r->>'externalId';
    if v_oc is null then
      v_guest := null;
      if r->>'huesped' is not null then
        insert into rentas.guest_minimo (organization_id, property_id, nombre, contacto) values (v_org, v_prop, r->>'huesped', r->>'contacto') returning id into v_guest;
      end if;
      insert into rentas.ocupacion (organization_id, property_id, unidad_id, rango, capa, razon, canal_origen_id, external_id, estado, bloqueante, huesped_minimo_id)
        values (v_org, v_prop, v_unidad, daterange(v_hoy + (r->>'desde')::int, v_hoy + (r->>'desde')::int + (r->>'noches')::int, '[)'), 'reserva', 'RESERVA_CANAL', v_canal, r->>'externalId', 'confirmado', true, v_guest)
        returning id into v_oc;
      if r->>'origen' = 'ical' then
        insert into rentas.evento_canal_importado (organization_id, property_id, unidad_id, canal_id, uid_evento, sequence, dtstamp, hash_contenido, ocupacion_id, ultima_accion)
          values (v_org, v_prop, v_unidad, v_canal, r->>'externalId', 0, (r->>'dtstamp')::timestamptz,
                  encode(sha256(convert_to(v_unidad::text || '|' || (r->>'desde') || '|' || (r->>'noches') || '|RESERVA_CANAL', 'UTF8')), 'hex'), v_oc, 'aplicar')
          on conflict (unidad_id, canal_id, uid_evento) do nothing;
      end if;
    end if;
    if r->'financiero' is not null and r->'financiero' <> 'null'::jsonb then
      v_rf := null;
      insert into rentas.reserva_financiero (organization_id, property_id, ocupacion_id, moneda, monto_bruto_centavos, ya_neto_de_comision, comision_canal_basis_points, comision_canal_fuente,
                                             comision_canal_centavos, comision_gestor_basis_points, comision_gestor_base, comision_gestor_centavos, monto_recibido_centavos,
                                             gastos_centavos, impuestos_centavos, neto_centavos, created_by)
        values (v_org, v_prop, v_oc, 'MXN', (r->'financiero'->>'brutoCentavos')::bigint, (r->'financiero'->>'yaNeto')::boolean, (r->'financiero'->>'comisionCanalBasisPoints')::int,
                r->'financiero'->>'comisionCanalFuente', (r->'financiero'->>'comisionCanalCentavos')::bigint, (r->'financiero'->>'comisionGestorBasisPoints')::int, 'neto_de_canal',
                (r->'financiero'->>'comisionGestorCentavos')::bigint, (r->'financiero'->>'montoRecibidoCentavos')::bigint, (r->'financiero'->>'gastosCentavos')::bigint, 0,
                (r->'financiero'->>'netoCentavos')::bigint, v_user)
        on conflict (ocupacion_id) do nothing
        returning id into v_rf;
      if v_rf is not null and (r->'financiero'->>'gastosCentavos')::bigint > 0 then
        insert into rentas.linea_gasto (reserva_financiero_id, tipo, descripcion, monto_centavos, creado_por)
          values (v_rf, 'limpieza', 'Limpieza de salida (demo)', (r->'financiero'->>'gastosCentavos')::bigint, v_user);
      end if;
    end if;
  end loop;

  -- 7) bloqueos y el conflicto abierto (la reserva importada cruza con un bloqueo de mantenimiento)
  for r in select * from jsonb_array_elements(v->'bloqueos') loop
    select p.id, pc.zona_horaria into v_prop, v_zona from core.property p join rentas.property_config pc on pc.property_id = p.id where p.organization_id = v_org and p.name = r->>'propiedad';
    v_hoy := (now() at time zone v_zona)::date;
    select id into v_unidad from rentas.unidad where property_id = v_prop and name = r->>'unidad';
    if not exists (select 1 from rentas.ocupacion where unidad_id = v_unidad and external_id = r->>'externalId') then
      insert into rentas.ocupacion (organization_id, property_id, unidad_id, rango, capa, razon, external_id, estado, bloqueante)
        values (v_org, v_prop, v_unidad, daterange(v_hoy + (r->>'desde')::int, v_hoy + (r->>'desde')::int + (r->>'noches')::int, '[)'), 'bloqueo', r->>'razon', r->>'externalId', 'confirmado', true);
    end if;
  end loop;
  x := v->'conflicto';
  select p.id into v_prop from core.property p where p.organization_id = v_org and p.name = x->>'propiedad';
  select id into v_unidad from rentas.unidad where property_id = v_prop and name = x->>'unidad';
  select id into v_oc from rentas.ocupacion where unidad_id = v_unidad and external_id = x->>'reservaExternalId';
  select id into v_oc_b from rentas.ocupacion where unidad_id = v_unidad and external_id = x->>'bloqueoExternalId';
  if not exists (select 1 from rentas.conflicto_calendario where ocupacion_a_id = v_oc and ocupacion_b_id = v_oc_b) then
    insert into rentas.conflicto_calendario (organization_id, property_id, unidad_id, ocupacion_a_id, ocupacion_b_id, tipo)
      values (v_org, v_prop, v_unidad, v_oc, v_oc_b, 'capa_cruzada');
  end if;

  -- 8) tareas de limpieza/inspeccion/mantenimiento con su checklist (solo si la organizacion demo aun no tiene)
  if not exists (select 1 from rentas.tarea_operativa where organization_id = v_org) then
    for r in select * from jsonb_array_elements(v->'tareas') loop
      select p.id, pc.zona_horaria into v_prop, v_zona from core.property p join rentas.property_config pc on pc.property_id = p.id where p.organization_id = v_org and p.name = r->>'propiedad';
      v_hoy := (now() at time zone v_zona)::date;
      select id into v_unidad from rentas.unidad where property_id = v_prop and name = r->>'unidad';
      v_oc := null;
      if r->>'deReservaExternalId' is not null then
        select id into v_oc from rentas.ocupacion where unidad_id = v_unidad and external_id = r->>'deReservaExternalId';
      end if;
      insert into rentas.tarea_operativa (organization_id, property_id, unidad_id, ocupacion_unidad_id, tipo, estado, prioridad, asignado_a, programada_para, sla_vence_en, completada_en)
        values (v_org, v_prop, v_unidad, v_oc, r->>'tipo', r->>'estado', r->>'prioridad',
                case when (r->>'asignadaAlOwner')::boolean then v_user else null end,
                v_hoy + (r->>'programadaPara')::int,
                case when r->>'slaHoras' is null then null else now() + make_interval(hours => (r->>'slaHoras')::int) end,
                case when r->>'estado' = 'completada' then now() - interval '1 day' else null end)
        returning id into v_tarea;
      insert into rentas.checklist_item_tarea (tarea_id, descripcion, orden, completado, completado_en, completado_por)
        select v_tarea, c.descripcion, c.orden::int - 1, r->>'estado' = 'completada', case when r->>'estado' = 'completada' then now() - interval '1 day' else null end,
               case when r->>'estado' = 'completada' then v_user else null end
        from jsonb_array_elements_text(r->'checklist') with ordinality as c(descripcion, orden);
    end loop;
  end if;

  -- 9) incidencia (solo si la organizacion demo aun no tiene)
  if not exists (select 1 from rentas.incidencia_mantenimiento where organization_id = v_org) then
    for r in select * from jsonb_array_elements(v->'incidencias') loop
      select id into v_prop from core.property where organization_id = v_org and name = r->>'propiedad';
      select id into v_unidad from rentas.unidad where property_id = v_prop and name = r->>'unidad';
      insert into rentas.incidencia_mantenimiento (organization_id, property_id, unidad_id, severidad, titulo, descripcion, estado, reportado_por)
        values (v_org, v_prop, v_unidad, r->>'severidad', r->>'titulo', r->>'descripcion', 'abierta', v_user);
    end loop;
  end if;

  -- 10) plantillas de mensajeria (por evento + idioma; una plantilla ya editada o aprobada por el usuario no se pisa)
  insert into rentas.plantilla_mensaje (organization_id, evento, idioma, canal_codigo, cuerpo, aprobada_por_tenant, activa)
    select v_org, p->>'evento', 'es', null, p->>'cuerpo', (p->>'aprobada')::boolean, true
    from jsonb_array_elements(v->'plantillas') p
    where not exists (select 1 from rentas.plantilla_mensaje q where q.organization_id = v_org and q.evento = p->>'evento' and q.idioma = 'es' and q.canal_codigo is null);

  -- 11) conversaciones con su borrador pendiente de aprobacion (solo si la organizacion demo aun no tiene)
  if not exists (select 1 from rentas.conversacion where organization_id = v_org) then
    for r in select * from jsonb_array_elements(v->'conversaciones') loop
      select id into v_prop from core.property where organization_id = v_org and name = r->>'propiedad';
      select id into v_unidad from rentas.unidad where property_id = v_prop and name = r->>'unidad';
      select id into v_oc from rentas.ocupacion where unidad_id = v_unidad and external_id = r->>'reservaExternalId';
      insert into rentas.conversacion (organization_id, property_id, unidad_id, canal_codigo, ocupacion_id, propiedad_nombre, huesped_nombre, fecha_check_in, fecha_check_out, reserva_confirmada)
        select v_org, v_prop, v_unidad, r->>'canal', o.id, r->>'propiedad', r->>'huesped', lower(o.rango), upper(o.rango), true from rentas.ocupacion o where o.id = v_oc
        returning id into v_conv;
      insert into rentas.mensaje (conversacion_id, direccion, origen, texto) values (v_conv, 'entrante', 'canal', r->>'mensajeEntrante') returning id into v_msg;
      insert into rentas.borrador_mensaje (conversacion_id, mensaje_entrante_id, canal_codigo, texto, estado, generado_por)
        values (v_conv, v_msg, r->>'canal', r->>'borradorPendiente', 'pendiente_aprobacion', 'agente_llm');
    end loop;
  end if;
end
$seed_fn$;
create or replace function public.limpiar_rentas_demo() returns void language plpgsql as $seed_fn$
declare
  v_org uuid;
  v_owners uuid[];
begin
  select id into v_org from core.organization where slug = 'demo-rentas-gestora' and vertical = 'rentas';
  if v_org is null then
    return;
  end if;
  select coalesce(array_agg(oo.owner_id), '{}') into v_owners from rentas.owner_organization oo
    where oo.organization_id = v_org
      and not exists (select 1 from rentas.owner_organization o2 where o2.owner_id = oo.owner_id and o2.organization_id <> v_org);
  delete from core.organization where id = v_org;
  delete from rentas.owner where id = any (v_owners);
end
$seed_fn$;

-- Fixtures persistentes: el staff dueño de la demo, una organizacion ajena con su propio staff.
insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-0000000000d1', 'duena@example.test', 'Duena Demo', 'seed'),
  ('00000000-0000-0000-0000-0000000000d2', 'intruso@example.test', 'Intruso Demo', 'seed')
on conflict do nothing;
insert into core.organization (id, vertical, name, slug) values ('00000000-0000-0000-0000-0000000000a9', 'rentas', 'Org ajena (verify seed rentas)', 'org-ajena-verify-seed-rentas') on conflict do nothing;
insert into core.property (id, organization_id, vertical, name) values ('00000000-0000-0000-0000-0000000000b9', '00000000-0000-0000-0000-0000000000a9', 'rentas', 'Propiedad ajena') on conflict do nothing;
insert into rentas.property_config (property_id, organization_id, zona_horaria, moneda) values ('00000000-0000-0000-0000-0000000000b9', '00000000-0000-0000-0000-0000000000a9', 'America/Merida', 'MXN') on conflict do nothing;
insert into rentas.organization_perfil (organization_id, tipo) values ('00000000-0000-0000-0000-0000000000a9', 'empresa_gestora') on conflict do nothing;
insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('00000000-0000-0000-0000-0000000000d2', '00000000-0000-0000-0000-0000000000a9', null, 'owner', 'admin_gestora')
on conflict do nothing;

\echo ''
\echo '=== A. Resultado del seed ==='
\echo ''
\echo '--- A1. 3 propiedades, 5 unidades y 3 propietarios en la organizacion demo ---'
begin;
select public.seed_rentas_demo();
select ((select count(*) from core.property where organization_id = (select id from core.organization where slug = 'demo-rentas-gestora')) = 3 and (select count(*) from rentas.unidad where organization_id = (select id from core.organization where slug = 'demo-rentas-gestora')) = 5 and (select count(*) from rentas.owner_organization where organization_id = (select id from core.organization where slug = 'demo-rentas-gestora')) = 3)::int as catalogo_correcto_deberia_ser_1;
rollback;
\echo '--- A2. 21 reservas: 8 importadas de los .ics (canal airbnb/booking/vrbo) y 13 directas (canal manual); todas confirmadas ---'
begin;
select public.seed_rentas_demo();
select ((select count(*) from rentas.ocupacion o join rentas.canal c on c.id = o.canal_origen_id where o.organization_id = (select id from core.organization where slug = 'demo-rentas-gestora') and o.capa = 'reserva' and c.codigo <> 'manual' and o.estado = 'confirmado') = 8 and (select count(*) from rentas.ocupacion o join rentas.canal c on c.id = o.canal_origen_id where o.organization_id = (select id from core.organization where slug = 'demo-rentas-gestora') and o.capa = 'reserva' and c.codigo = 'manual' and o.estado = 'confirmado') = 13)::int as reservas_correctas_deberia_ser_1;
rollback;
\echo '--- A3. 8 eventos importados registrados (uno por reserva de .ics) y 3 feeds: 2 al dia y 1 en cuarentena ---'
begin;
select public.seed_rentas_demo();
select ((select count(*) from rentas.evento_canal_importado where organization_id = (select id from core.organization where slug = 'demo-rentas-gestora')) = 8 and (select count(*) from rentas.canal_feed_externo where organization_id = (select id from core.organization where slug = 'demo-rentas-gestora')) = 3 and (select count(*) from rentas.canal_feed_externo where organization_id = (select id from core.organization where slug = 'demo-rentas-gestora') and en_cuarentena_desde is not null) = 1 and (select count(*) from rentas.canal_feed_externo where organization_id = (select id from core.organization where slug = 'demo-rentas-gestora') and url_importacion not like 'https://calendarios.demo.invalid/%') = 0)::int as feeds_correctos_deberia_ser_1;
rollback;
\echo '--- A4. un conflicto abierto (capa cruzada: reserva importada de Airbnb contra un bloqueo de mantenimiento) y un bloqueo ---'
begin;
select public.seed_rentas_demo();
select ((select count(*) from rentas.conflicto_calendario where organization_id = (select id from core.organization where slug = 'demo-rentas-gestora') and resuelto_en is null and tipo = 'capa_cruzada') = 1 and (select count(*) from rentas.ocupacion where organization_id = (select id from core.organization where slug = 'demo-rentas-gestora') and capa = 'bloqueo' and razon = 'MANTENIMIENTO') = 1)::int as conflicto_correcto_deberia_ser_1;
rollback;
\echo '--- A5. 5 tareas (1 vencida, 1 completada con checklist completo) y 1 incidencia abierta ---'
begin;
select public.seed_rentas_demo();
select ((select count(*) from rentas.tarea_operativa where organization_id = (select id from core.organization where slug = 'demo-rentas-gestora')) = 5 and (select count(*) from rentas.tarea_operativa where organization_id = (select id from core.organization where slug = 'demo-rentas-gestora') and estado not in ('completada','cancelada') and sla_vence_en < now()) = 1 and (select count(*) from rentas.checklist_item_tarea c join rentas.tarea_operativa t on t.id = c.tarea_id where t.organization_id = (select id from core.organization where slug = 'demo-rentas-gestora') and t.estado = 'completada' and not c.completado) = 0 and (select count(*) from rentas.incidencia_mantenimiento where organization_id = (select id from core.organization where slug = 'demo-rentas-gestora') and estado = 'abierta') = 1)::int as tareas_correctas_deberia_ser_1;
rollback;
\echo '--- A6. 5 plantillas (2 aprobadas por el tenant), 2 conversaciones con su borrador pendiente de aprobacion ---'
begin;
select public.seed_rentas_demo();
select ((select count(*) from rentas.plantilla_mensaje where organization_id = (select id from core.organization where slug = 'demo-rentas-gestora')) = 5 and (select count(*) from rentas.plantilla_mensaje where organization_id = (select id from core.organization where slug = 'demo-rentas-gestora') and aprobada_por_tenant) = 2 and (select count(*) from rentas.borrador_mensaje b join rentas.conversacion c on c.id = b.conversacion_id where c.organization_id = (select id from core.organization where slug = 'demo-rentas-gestora') and b.estado = 'pendiente_aprobacion' and b.generado_por = 'agente_llm') = 2)::int as mensajeria_correcta_deberia_ser_1;
rollback;
\echo '--- A7. reglas de comision: las 4 sugeridas quedan confirmadas con fuente de demo (ninguna default_sugerido) ---'
begin;
select public.seed_rentas_demo();
select ((select count(*) from rentas.regla_comision_canal where organization_id = (select id from core.organization where slug = 'demo-rentas-gestora')) = 4 and (select count(*) from rentas.regla_comision_canal where organization_id = (select id from core.organization where slug = 'demo-rentas-gestora') and fuente like 'default\_sugerido%') = 0 and (select count(*) from rentas.regla_comision_canal where organization_id = (select id from core.organization where slug = 'demo-rentas-gestora') and fuente like 'Demo:%') = 4)::int as reglas_correctas_deberia_ser_1;
rollback;
\echo '--- A8. 9 movimientos financieros coherentes: neto = recibido - comision del gestor - gastos - impuestos; las lineas de gasto suman lo que dice el movimiento ---'
begin;
select public.seed_rentas_demo();
select ((select count(*) from rentas.reserva_financiero where organization_id = (select id from core.organization where slug = 'demo-rentas-gestora')) = 9 and (select count(*) from rentas.reserva_financiero where organization_id = (select id from core.organization where slug = 'demo-rentas-gestora') and neto_centavos <> monto_recibido_centavos - comision_gestor_centavos - gastos_centavos - impuestos_centavos) = 0 and (select count(*) from rentas.reserva_financiero rf where rf.organization_id = (select id from core.organization where slug = 'demo-rentas-gestora') and rf.gastos_centavos <> coalesce((select sum(lg.monto_centavos) from rentas.linea_gasto lg where lg.reserva_financiero_id = rf.id), 0)) = 0)::int as finanzas_coherentes_deberia_ser_1;
rollback;
\echo '--- A9. todo es ficticio y esta marcado: slug demo-, nombre (demo), correos @example.test, contactos con lada 00, ningun movimiento en una reserva futura ---'
begin;
select public.seed_rentas_demo();
select ((select count(*) from core.organization where id = (select id from core.organization where slug = 'demo-rentas-gestora') and slug like 'demo-%' and name like '%(demo)') = 1 and (select count(*) from rentas.owner o join rentas.owner_organization oo on oo.owner_id = o.id where oo.organization_id = (select id from core.organization where slug = 'demo-rentas-gestora') and o.email not like '%@example.test') = 0 and (select count(*) from rentas.guest_minimo where organization_id = (select id from core.organization where slug = 'demo-rentas-gestora') and contacto not like '+52 00 %') = 0 and (select count(*) from rentas.reserva_financiero rf join rentas.ocupacion o on o.id = rf.ocupacion_id where rf.organization_id = (select id from core.organization where slug = 'demo-rentas-gestora') and upper(o.rango) > current_date + 1) = 0)::int as demo_marcada_deberia_ser_1;
rollback;
\echo '--- A10. la consola de superadmin cuenta la cuenta como demo (criterio slug demo-%) y el dueño quedo como admin_gestora de acceso total ---'
begin;
select public.seed_rentas_demo();
select ((select count(*) from core.organization where vertical = 'rentas' and slug like 'demo-%' and id = (select id from core.organization where slug = 'demo-rentas-gestora')) = 1 and (select count(*) from core.membership where organization_id = (select id from core.organization where slug = 'demo-rentas-gestora') and user_id = '00000000-0000-0000-0000-0000000000d1' and vertical_role = 'admin_gestora' and platform_role = 'owner' and property_ids is null) = 1)::int as marca_y_dueno_deberia_ser_1;
rollback;

\echo ''
\echo '=== B. Lo que ven el Resumen, los reportes, el monitor y el checklist (consultas de los repositorios, como el staff autenticado) ==='
\echo ''
\echo '--- B1. Resumen: llegadas y salidas de HOY en la zona de Casa del Mar (Cancun): llega 1 (Booking) y sale 1 (Airbnb) ---'
begin;
select public.seed_rentas_demo();
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000d1', true);
select (select count(*) filter (where lower(o.rango) = (now() at time zone 'America/Cancun')::date) * 10 + count(*) filter (where upper(o.rango) = (now() at time zone 'America/Cancun')::date) from rentas.ocupacion o where o.property_id = (select p.id from core.property p where p.organization_id = (select id from core.organization where slug = 'demo-rentas-gestora') and p.name = 'Casa del Mar (demo)') and o.capa = 'reserva' and o.estado = 'confirmado' and (lower(o.rango) = (now() at time zone 'America/Cancun')::date or upper(o.rango) = (now() at time zone 'America/Cancun')::date)) as llegadas_x10_mas_salidas_deberia_ser_11;
rollback;
\echo '--- B2. Resumen: tareas pendientes y vencidas de Casa del Mar (2 pendientes, 1 vencida) ---'
begin;
select public.seed_rentas_demo();
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000d1', true);
select (count(*) filter (where t.estado not in ('completada', 'cancelada')) * 10 + count(*) filter (where t.estado not in ('completada', 'cancelada') and t.sla_vence_en is not null and t.sla_vence_en < now())) as pendientes_x10_mas_vencidas_deberia_ser_21 from rentas.tarea_operativa t where t.property_id = (select p.id from core.property p where p.organization_id = (select id from core.organization where slug = 'demo-rentas-gestora') and p.name = 'Casa del Mar (demo)');
rollback;
\echo '--- B3. Resumen: borradores por aprobar (1 en Casa del Mar) y el ultimo generado por el agente ---'
begin;
select public.seed_rentas_demo();
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000d1', true);
select count(*) filter (where b.estado = 'pendiente_aprobacion') as borradores_pendientes_deberia_ser_1 from rentas.borrador_mensaje b join rentas.conversacion c on c.id = b.conversacion_id where c.property_id = (select p.id from core.property p where p.organization_id = (select id from core.organization where slug = 'demo-rentas-gestora') and p.name = 'Casa del Mar (demo)');
rollback;
\echo '--- B4. Monitor: los 2 feeds de Casa del Mar estan activos y sin cuarentena ---'
begin;
select public.seed_rentas_demo();
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000d1', true);
select count(*) as feeds_sanos_deberia_ser_2 from rentas.canal_feed_externo cfe join rentas.canal c on c.id = cfe.canal_id join rentas.unidad u on u.id = cfe.unidad_id where cfe.property_id = (select p.id from core.property p where p.organization_id = (select id from core.organization where slug = 'demo-rentas-gestora') and p.name = 'Casa del Mar (demo)') and cfe.activo and cfe.en_cuarentena_desde is null;
rollback;
\echo '--- B5. Monitor: el feed de Vrbo del Loft esta en cuarentena con su motivo ---'
begin;
select public.seed_rentas_demo();
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000d1', true);
select count(*) as feeds_en_cuarentena_deberia_ser_1 from rentas.canal_feed_externo cfe join rentas.canal c on c.id = cfe.canal_id where cfe.property_id = (select p.id from core.property p where p.organization_id = (select id from core.organization where slug = 'demo-rentas-gestora') and p.name = 'Loft Centro (demo)') and c.codigo = 'vrbo' and cfe.en_cuarentena_desde is not null and cfe.motivo_cuarentena is not null and cfe.intentos_fallidos_consecutivos = 6;
rollback;
\echo '--- B6. Monitor: el listado de conflictos (misma consulta que listarConflictos) devuelve el abierto con sus dos ocupaciones ---'
begin;
select public.seed_rentas_demo();
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000d1', true);
select count(*) as conflictos_abiertos_deberia_ser_1 from (select k.id from rentas.conflicto_calendario k join rentas.unidad u on u.id = k.unidad_id join rentas.ocupacion a on a.id = k.ocupacion_a_id left join rentas.canal ca on ca.id = a.canal_origen_id left join rentas.ocupacion b on b.id = k.ocupacion_b_id left join rentas.canal cb on cb.id = b.canal_origen_id where k.property_id = (select p.id from core.property p where p.organization_id = (select id from core.organization where slug = 'demo-rentas-gestora') and p.name = 'Casa del Mar (demo)') and k.resuelto_en is null and ca.codigo = 'airbnb' and b.razon = 'MANTENIMIENTO' order by (k.resuelto_en is not null), k.detectado_en desc, k.id limit 50) q;
rollback;
\echo '--- B7. Reportes: el reporte de ocupacion de Casa del Mar (misma consulta que cargarDatosReporte, ultimos 60 dias) trae 5 reservas con su movimiento financiero ---'
begin;
select public.seed_rentas_demo();
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000d1', true);
select count(*) as reservas_con_movimiento_deberia_ser_5 from rentas.ocupacion o join rentas.unidad u on u.id = o.unidad_id left join rentas.canal c on c.id = o.canal_origen_id left join rentas.reserva_financiero rf on rf.ocupacion_id = o.id where o.property_id = (select p.id from core.property p where p.organization_id = (select id from core.organization where slug = 'demo-rentas-gestora') and p.name = 'Casa del Mar (demo)') and o.capa = 'reserva' and o.estado = 'confirmado' and o.rango && daterange(((now() at time zone 'America/Cancun')::date - 60), ((now() at time zone 'America/Cancun')::date + 1), '[)') and rf.id is not null;
rollback;
\echo '--- B8. Reportes: el dueño ve las 21 reservas de la organizacion demo y la ocupacion del mes en Casa del Mar es mayor que cero ---'
begin;
select public.seed_rentas_demo();
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000d1', true);
select ((select count(*) from rentas.ocupacion where organization_id = (select id from core.organization where slug = 'demo-rentas-gestora') and capa = 'reserva') = 21 and (select count(*) from rentas.ocupacion o where o.property_id = (select p.id from core.property p where p.organization_id = (select id from core.organization where slug = 'demo-rentas-gestora') and p.name = 'Casa del Mar (demo)') and o.capa = 'reserva' and o.estado = 'confirmado' and o.rango && daterange(date_trunc('month', now() at time zone 'America/Cancun')::date, (date_trunc('month', now() at time zone 'America/Cancun') + interval '1 month')::date, '[)')) > 0)::int as reportes_con_datos_deberia_ser_1;
rollback;
\echo '--- B9. Checklist Rn-36 (mismas consultas del repositorio): iCal 3 activos (1 en cuarentena) y 2 sincronizados, 5 de 5 unidades con tarifa, 4 reglas confirmadas, 1 propiedad con acceso activo, 3 propietarios, 2 plantillas aprobadas ---'
begin;
select public.seed_rentas_demo();
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000d1', true);
select ((select count(*) filter (where activo) from rentas.canal_feed_externo where organization_id = (select id from core.organization where slug = 'demo-rentas-gestora')) = 3 and (select count(*) filter (where activo and en_cuarentena_desde is null and ultima_sincronizacion_exitosa_en is not null) from rentas.canal_feed_externo where organization_id = (select id from core.organization where slug = 'demo-rentas-gestora')) = 2 and (select count(*) filter (where activo and en_cuarentena_desde is not null) from rentas.canal_feed_externo where organization_id = (select id from core.organization where slug = 'demo-rentas-gestora')) = 1 and (select count(distinct unidad_id) from rentas.tarifa_base where organization_id = (select id from core.organization where slug = 'demo-rentas-gestora')) = (select count(*) from rentas.unidad where organization_id = (select id from core.organization where slug = 'demo-rentas-gestora')) and (select count(*) from rentas.regla_comision_canal where organization_id = (select id from core.organization where slug = 'demo-rentas-gestora') and fuente not like 'default\_sugerido%') = 4 and (select count(*) from rentas.acceso_politica where organization_id = (select id from core.organization where slug = 'demo-rentas-gestora') and activo) = 1 and (select count(*) from rentas.owner_organization where organization_id = (select id from core.organization where slug = 'demo-rentas-gestora')) = 3 and (select count(*) from rentas.plantilla_mensaje where organization_id = (select id from core.organization where slug = 'demo-rentas-gestora') and aprobada_por_tenant and activa) = 2)::int as checklist_con_datos_deberia_ser_1;
rollback;
\echo '--- B10. Checklist: el staff (solo el dueño, sin invitaciones) queda PENDIENTE: 1 miembro y 0 invitaciones pendientes ---'
begin;
select public.seed_rentas_demo();
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000d1', true);
select ((select count(*) from core.membership where organization_id = (select id from core.organization where slug = 'demo-rentas-gestora')) = 1 and (select count(*) from core.staff_invite where organization_id = (select id from core.organization where slug = 'demo-rentas-gestora') and status = 'pending') = 0)::int as staff_pendiente_deberia_ser_1;
rollback;
\echo '--- B11. Checklist: una organizacion NUEVA nace con 4 reglas sugeridas y NINGUNA cuenta como confirmada (el punto no nace hecho) ---'
begin;
select public.seed_rentas_demo();
select ((select count(*) from rentas.regla_comision_canal where organization_id = '00000000-0000-0000-0000-0000000000a9') = 4 and (select count(*) from rentas.regla_comision_canal where organization_id = '00000000-0000-0000-0000-0000000000a9' and fuente not like 'default\_sugerido%') = 0)::int as reglas_sugeridas_no_cuentan_deberia_ser_1;
rollback;

\echo ''
\echo '=== C. Idempotencia ==='
\echo ''
\echo '--- C1. ejecutar el seed dos veces NO duplica reservas, huespedes, movimientos ni lineas de gasto (22 ocupaciones, 13 huespedes, 9 movimientos, 5 gastos) ---'
begin;
select public.seed_rentas_demo();
select public.seed_rentas_demo();
select (select count(*) from rentas.ocupacion where organization_id = (select id from core.organization where slug = 'demo-rentas-gestora')) * 1000000 + (select count(*) from rentas.guest_minimo where organization_id = (select id from core.organization where slug = 'demo-rentas-gestora')) * 10000 + (select count(*) from rentas.reserva_financiero where organization_id = (select id from core.organization where slug = 'demo-rentas-gestora')) * 100 + (select count(*) from rentas.linea_gasto lg join rentas.reserva_financiero rf on rf.id = lg.reserva_financiero_id where rf.organization_id = (select id from core.organization where slug = 'demo-rentas-gestora')) as ocupaciones_huespedes_movimientos_gastos_deberia_ser_22130905;
rollback;
\echo '--- C2. ni tareas, conversaciones, borradores o plantillas (5 tareas, 2 conversaciones, 2 borradores, 5 plantillas) ---'
begin;
select public.seed_rentas_demo();
select public.seed_rentas_demo();
select (select count(*) from rentas.tarea_operativa where organization_id = (select id from core.organization where slug = 'demo-rentas-gestora')) * 1000000 + (select count(*) from rentas.conversacion where organization_id = (select id from core.organization where slug = 'demo-rentas-gestora')) * 10000 + (select count(*) from rentas.borrador_mensaje b join rentas.conversacion c on c.id = b.conversacion_id where c.organization_id = (select id from core.organization where slug = 'demo-rentas-gestora')) * 100 + (select count(*) from rentas.plantilla_mensaje where organization_id = (select id from core.organization where slug = 'demo-rentas-gestora')) as tareas_conversaciones_borradores_plantillas_deberia_ser_5020205;
rollback;
\echo '--- C3. ni propiedades, unidades, propietarios, feeds, tarifas, eventos importados o la politica de acceso ---'
begin;
select public.seed_rentas_demo();
select public.seed_rentas_demo();
select ((select count(*) from core.property where organization_id = (select id from core.organization where slug = 'demo-rentas-gestora')) = 3 and (select count(*) from rentas.unidad where organization_id = (select id from core.organization where slug = 'demo-rentas-gestora')) = 5 and (select count(*) from rentas.owner o join rentas.owner_organization oo on oo.owner_id = o.id where oo.organization_id = (select id from core.organization where slug = 'demo-rentas-gestora')) = 3 and (select count(*) from rentas.canal_feed_externo where organization_id = (select id from core.organization where slug = 'demo-rentas-gestora')) = 3 and (select count(*) from rentas.tarifa_base where organization_id = (select id from core.organization where slug = 'demo-rentas-gestora')) = 5 and (select count(*) from rentas.tarifa_temporada where organization_id = (select id from core.organization where slug = 'demo-rentas-gestora')) = 1 and (select count(*) from rentas.evento_canal_importado where organization_id = (select id from core.organization where slug = 'demo-rentas-gestora')) = 8 and (select count(*) from rentas.acceso_politica where organization_id = (select id from core.organization where slug = 'demo-rentas-gestora')) = 1 and (select count(*) from rentas.regla_comision_canal where organization_id = (select id from core.organization where slug = 'demo-rentas-gestora')) = 4)::int as sin_duplicados_deberia_ser_1;
rollback;
\echo '--- C4. NO pisa lo que el usuario ya edito: una regla de comision con su propia fuente y una plantilla con otro cuerpo se conservan al re-ejecutar ---'
begin;
select public.seed_rentas_demo();
update rentas.regla_comision_canal set comision_basis_points = 1234, fuente = 'Mi contrato firmado' where organization_id = (select id from core.organization where slug = 'demo-rentas-gestora') and canal_id = (select id from rentas.canal where codigo = 'booking');
update rentas.plantilla_mensaje set cuerpo = 'Mi texto propio para {{huesped}}' where organization_id = (select id from core.organization where slug = 'demo-rentas-gestora') and evento = 'check_in';
update rentas.plantilla_mensaje set aprobada_por_tenant = true where organization_id = (select id from core.organization where slug = 'demo-rentas-gestora') and evento = 'check_in';
select public.seed_rentas_demo();
select ((select count(*) from rentas.regla_comision_canal where organization_id = (select id from core.organization where slug = 'demo-rentas-gestora') and comision_basis_points = 1234 and fuente = 'Mi contrato firmado') = 1 and (select count(*) from rentas.plantilla_mensaje where organization_id = (select id from core.organization where slug = 'demo-rentas-gestora') and evento = 'check_in' and cuerpo = 'Mi texto propio para {{huesped}}' and aprobada_por_tenant) = 1)::int as ediciones_del_usuario_conservadas_deberia_ser_1;
rollback;
\echo '--- C5. una reserva que el usuario cancelo no se reinserta al re-ejecutar (la llave es el external_id, no las fechas) ---'
begin;
select public.seed_rentas_demo();
update rentas.ocupacion set estado = 'cancelado' where organization_id = (select id from core.organization where slug = 'demo-rentas-gestora') and external_id = 'demo-dir-d2';
select public.seed_rentas_demo();
select ((select count(*) from rentas.ocupacion where organization_id = (select id from core.organization where slug = 'demo-rentas-gestora') and external_id = 'demo-dir-d2') = 1 and (select estado from rentas.ocupacion where organization_id = (select id from core.organization where slug = 'demo-rentas-gestora') and external_id = 'demo-dir-d2') = 'cancelado')::int as no_reinserta_deberia_ser_1;
rollback;

\echo ''
\echo '=== D. Aislamiento y seguridad ==='
\echo ''
\echo '--- D1. si el slug demo ya existe en OTRA vertical el seed ABORTA sin tocarla ---'
begin;
insert into core.organization (vertical, name, slug) values ('citas', 'Ocupa el slug', 'demo-rentas-gestora');
select public.seed_rentas_demo() as should_fail;
rollback;

\echo '--- D2. si el correo del dueño no existe el seed ABORTA (no crea credenciales) ---'
begin;
select public.seed_rentas_demo_sin_duena() as should_fail;
rollback;

\echo '--- D3. anon no puede leer nada de rentas (sin GRANT) ---'
begin;
select public.seed_rentas_demo();
set local role anon;
select count(*) as should_fail from rentas.ocupacion;
rollback;

\echo '--- D4. cross-tenant: el staff de OTRA organizacion no ve ninguna reserva, feed, movimiento, tarea, plantilla, conversacion ni borrador de la demo ---'
begin;
select public.seed_rentas_demo();
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000d2', true);
select (select count(*) from rentas.ocupacion) + (select count(*) from rentas.canal_feed_externo) + (select count(*) from rentas.reserva_financiero) + (select count(*) from rentas.tarea_operativa) + (select count(*) from rentas.plantilla_mensaje where aprobada_por_tenant) + (select count(*) from rentas.conversacion) + (select count(*) from rentas.borrador_mensaje) + (select count(*) from rentas.unidad) + (select count(*) from rentas.owner) as filas_ajenas_visibles_deberia_ser_0;
rollback;
\echo '--- D5. cross-tenant: el staff de otra organizacion tampoco ve las propiedades ni la politica de acceso de la demo ---'
begin;
select public.seed_rentas_demo();
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000d2', true);
select (select count(*) from core.property where name like '%(demo)') + (select count(*) from rentas.acceso_politica) + (select count(*) from rentas.regla_comision_canal where organization_id <> '00000000-0000-0000-0000-0000000000a9') as propiedades_ajenas_visibles_deberia_ser_0;
rollback;
\echo '--- D6. la limpieza (limpiar_rentas_demo) se lleva TODO lo de la demo -- organizacion en cascada y propietarios huerfanos -- y no toca a la otra organizacion ---'
begin;
select public.seed_rentas_demo();
select public.limpiar_rentas_demo();
select ((select count(*) from core.organization where slug = 'demo-rentas-gestora') + (select count(*) from core.property where name like '%(demo)') + (select count(*) from rentas.ocupacion) + (select count(*) from rentas.unidad) + (select count(*) from rentas.owner) + (select count(*) from rentas.guest_minimo) + (select count(*) from rentas.reserva_financiero) + (select count(*) from rentas.linea_gasto) + (select count(*) from rentas.tarea_operativa) + (select count(*) from rentas.conversacion) + (select count(*) from rentas.plantilla_mensaje) + (select count(*) from rentas.canal_feed_externo) = 0 and (select count(*) from core.organization where id = '00000000-0000-0000-0000-0000000000a9') = 1 and (select count(*) from rentas.regla_comision_canal where organization_id = '00000000-0000-0000-0000-0000000000a9') = 4)::int as demo_borrada_y_ajena_intacta_deberia_ser_1;
rollback;

\echo '--- D7. un propietario compartido con OTRA organizacion se conserva al limpiar (solo se borran los que eran exclusivos de la demo) ---'
begin;
select public.seed_rentas_demo();
insert into rentas.owner_organization (owner_id, organization_id) select o.id, '00000000-0000-0000-0000-0000000000a9' from rentas.owner o where o.email = 'ana.propietaria@example.test';
select public.limpiar_rentas_demo();
select ((select count(*) from rentas.owner) = 1 and (select count(*) from rentas.owner where email = 'ana.propietaria@example.test') = 1)::int as propietario_compartido_conservado_deberia_ser_1;
rollback;

\echo '--- D8. limpiar sin demo cargada no hace nada ni falla ---'
begin;
select public.limpiar_rentas_demo();
select (select count(*) from core.organization where id = '00000000-0000-0000-0000-0000000000a9') as organizacion_ajena_intacta_deberia_ser_1;
rollback;

\echo ''
\echo '==> listo -- los escenarios marcados con should_fail deben terminar en ERROR; los demas devuelven el valor indicado en el alias.'
