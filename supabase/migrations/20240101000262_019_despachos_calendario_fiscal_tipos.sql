-- Decimonovena migración del esquema `despachos.*` (D-26) — amplía los tipos de vencimiento fiscal.
--
-- Contexto: el motor de vencimientos (`domain-despachos/src/vencimientos/calendario-fiscal.ts`) ahora
-- genera, además de ISR/IVA/DIOT/Nómina, la balanza de comprobación de contabilidad electrónica
-- ('Balanza') y la declaración anual ('Anual'). El CHECK original de `tipo` (migración 001) solo
-- admitía los cuatro primeros, así que insertar los nuevos fallaría con SQLSTATE 23514.
--
-- Qué hace: reemplaza ese CHECK por uno que admite los 6 valores. No agrega tablas, columnas,
-- funciones, policies ni GRANT.
--
-- Justificación de seguridad:
--  * Sin GRANT nuevos: los de `despachos.fiscal_deadline` (select/insert/update a `authenticated`,
--    migración 001) no cambian; no hay GRANT a `anon`.
--  * Sin policy nueva ni modificada: el aislamiento por property sigue siendo
--    `core.has_property_access` (001). Ampliar el CHECK no abre ninguna fila a otro tenant.
--  * El CHECK sigue siendo una lista cerrada (no `tipo <> ''`): un cliente no puede inventar tipos.
--  * No usa `security definer` ni funciones nuevas.
--
-- Compatibilidad con la base sin migrar: el código TypeScript captura 23514 al insertar 'Balanza'
-- o 'Anual' dentro de un SAVEPOINT y degrada a "omitido, requiere la migración 019"; los cuatro tipos
-- originales siguen funcionando sin esta migración.
--
-- Idempotente: busca el CHECK por su definición (no por nombre) y lo reemplaza solo si es el viejo.
do $$
declare
  v_nombre text;
begin
  select c.conname into v_nombre
    from pg_constraint c
   where c.conrelid = 'despachos.fiscal_deadline'::regclass
     and c.contype = 'c'
     and pg_get_constraintdef(c.oid) like '%tipo%ISR%IVA%DIOT%'
     and pg_get_constraintdef(c.oid) not like '%Balanza%';
  if v_nombre is not null then
    execute format('alter table despachos.fiscal_deadline drop constraint %I', v_nombre);
  end if;
end $$;

alter table despachos.fiscal_deadline drop constraint if exists fiscal_deadline_tipo_check;
alter table despachos.fiscal_deadline
  add constraint fiscal_deadline_tipo_check
  check (tipo in ('ISR', 'IVA', 'DIOT', 'Nómina', 'Balanza', 'Anual'));
