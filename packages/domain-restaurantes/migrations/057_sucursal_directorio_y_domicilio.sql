-- Directorio publico de sucursales y domicilio por sucursal (huecos-finales-restaurantes, seccion 1).
--
-- Problema: el sitio publico solo listaba las sucursales ACTIVAS y `branch_policy` (023) no podia expresar
-- que una sucursal reparte solo algunos dias ni que no reparte (solo recoger). Se agregan CUATRO columnas
-- a `restaurantes.branch_policy`:
--
--   * visible_en_directorio boolean null -- null = sigue a la sucursal activa (comportamiento anterior);
--     true = aparece en /pedir/:org/sucursales aunque este inactiva ("solo informativa"); false = oculta.
--   * acepta_domicilio boolean not null default true -- false = solo recoger.
--   * dias_domicilio smallint[] null -- dias de la semana (0 = domingo .. 6 = sabado) en que SI reparte;
--     null = todos los dias.
--   * de_temporada boolean not null default false -- insignia publica "Temporada".
--
-- Decision de diseno: son columnas NUEVAS con default que conserva el comportamiento actual; ninguna
-- modifica una restriccion existente. El codigo TypeScript que las lee degrada con SAVEPOINT cuando la
-- base todavia no las tiene (SQLSTATE 42703): cae a la lectura de 023 y la regla de domicilio no se aplica.
-- Nada de esto se aplica al mergear.
--
-- Justificacion de seguridad (una por una):
--
--  * RLS: sin cambios. Las policies de 023 (SELECT para staff de la organizacion o sesion de SISTEMA con
--    auth.uid() is null; INSERT/UPDATE solo owner/admin con `with check` de organizacion) cubren las
--    columnas nuevas por ser de la misma fila. El storefront publico las lee con la sesion de sistema
--    (mismo patron que 014/023) y la capa de dominio solo expone los campos publicos (nombre, direccion,
--    telefono, horario, banderas de directorio/domicilio); `anon` sigue SIN ningun acceso a la tabla.
--  * GRANT por COLUMNA: las funciones reales solo escriben estas columnas desde el panel (owner/admin), asi
--    que se agregan al GRANT INSERT y al GRANT UPDATE por columna ya existentes. `organization_id` sigue
--    sin UPDATE (una fila no cambia de tenant). No se concede nada a `anon` ni se usa `using (true)`.
--  * CHECK en `dias_domicilio`: 1 a 7 dias, todos entre 0 y 6, sin nulos, para que un dato corrupto no pueda
--    silenciar ni bloquear el domicilio por accidente.

alter table restaurantes.branch_policy
  add column if not exists visible_en_directorio boolean,
  add column if not exists acepta_domicilio boolean not null default true,
  add column if not exists dias_domicilio smallint[],
  add column if not exists de_temporada boolean not null default false;

-- Reaplicable: se suelta la restriccion (si existe) antes de crearla de nuevo.
alter table restaurantes.branch_policy
  drop constraint if exists branch_policy_dias_domicilio_check;
alter table restaurantes.branch_policy
  add constraint branch_policy_dias_domicilio_check
  check (
    dias_domicilio is null
    or (
      cardinality(dias_domicilio) between 1 and 7
      and array_position(dias_domicilio, null) is null
      and dias_domicilio <@ array[0, 1, 2, 3, 4, 5, 6]::smallint[]
    )
  );

grant insert (visible_en_directorio, acepta_domicilio, dias_domicilio, de_temporada)
  on restaurantes.branch_policy to authenticated;
grant update (visible_en_directorio, acepta_domicilio, dias_domicilio, de_temporada)
  on restaurantes.branch_policy to authenticated;
