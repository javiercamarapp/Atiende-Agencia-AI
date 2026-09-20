# verify-hoteles-zona-horaria

Verificación manual, opt-in, contra un Postgres LOCAL real (mismo patrón que
`scripts/verify-hoteles-motor-tarifas/`) de que
`packages/domain-hoteles/migrations/030_zona_horaria_property.sql` (FASE 3,
producto — zona horaria por negocio) cierra lo que dice cerrar: RLS/GRANT reales
sobre `hoteles.property_config`, el trigger que deriva/congela `organization_id`
desde `core.property`, y el fallback SQLSTATE 42703/42P01 (esquema a medio migrar)
recuperado con `SAVEPOINT` real.

## Uso

```
scripts/verify-hoteles-zona-horaria/run.sh
```

Requiere `initdb`/`pg_ctl`/`psql` en PATH (Postgres local, ej. `brew install
postgresql`). Levanta un Postgres efímero, aplica TODAS las migraciones reales de
`supabase/migrations/`, y corre `assertions.sql`.

## Qué prueba (12 escenarios, ver comentario de cabecera de `assertions.sql`)

1-3. Positivo: owner configura la zona horaria de su property (upsert real); gm
   puede actualizarla después (mismo nivel, `hoteles.can_manage_catalog()`); el
   trigger ignora un `organization_id` ajeno que el cliente mande y lo deriva
   siempre de `core.property` (defensa en profundidad).
4-5. Negativo: frontdesk (rol insuficiente) y el owner de otra organización
   (cross-tenant) no pueden configurarla — la policy de INSERT filtra en silencio
   (0 filas), nunca una excepción.
6. Cross-tenant en LECTURA: fixture persistente de la property de Hotel A, el
   owner de Hotel B no la ve (`core.has_property_access` la excluye).
7. `anon`: rechazado por completo, lectura y escritura.
8. Sesión de SISTEMA (`auth.uid() is null`) SÍ puede leer — necesario para el
   `LEFT JOIN` que `listActiveHotelProperties()` usa en los barridos de
   night-audit y del motor de recomendaciones de tarifa (ambos corren siempre bajo
   sesión de sistema); sin esto, el barrido vería cero filas en silencio.
9. GRANT a nivel columna: un `UPDATE` directo de `organization_id` (columna sin
   GRANT — el upsert real de la aplicación solo escribe `timezone`) es rechazado
   por Postgres (`insufficient_privilege`) ANTES de que RLS opine.
10-11. Esquema de producción a medio migrar (REGLA DURA del repo): con la columna
   `timezone` eliminada (42703) o con la tabla completa eliminada (42P01) dentro de
   la MISMA transacción, `SAVEPOINT`/`ROLLBACK TO SAVEPOINT` (mismo mecanismo que
   `runWithSavepointFallback` en producción) recupera la sesión — la consulta
   siguiente, completamente ajena, corre normal (nunca `25P02`).
12. Control: tras los dos `DROP`/`ALTER` destructivos de 10/11 (ambos dentro de su
   propio `begin/rollback`, DDL transaccional en Postgres), la tabla real y su
   fixture siguen intactas.

## Por qué corre bajo `authenticated` (con `auth.uid()` real), no `service_role`

A diferencia de `verify-fecha-negocio-postgres-real`/`verify-despachos-fechas-
postgres-real` (que verifican solo la FORMA del SQL, sin RLS), lo que este script
verifica es exactamente RLS/GRANT/el trigger — mismo criterio que
`verify-hoteles-motor-tarifas`/`verify-hoteles-sql-critico`.
