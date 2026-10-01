# verify-hoteles-recepcion-ficha

Verificación contra Postgres REAL (mismo patrón que `scripts/verify-hoteles-grupos/`) de
`packages/domain-hoteles/migrations/038_hoteles_recepcion_ficha_huesped.sql` (H-27 ficha de huésped y H-28 recepción):
notas y preferencias del huésped, cambio de habitación atómico con bitácora y bandera ARCO.

```
scripts/verify-hoteles-recepcion-ficha/run.sh        # manual, Postgres efímero local
node scripts/verify-real-postgres-ci/run-gate.mjs scripts/verify-hoteles-recepcion-ficha
```

En CI lo ejecuta automáticamente el gate `Postgres real` (auto-descubre `scripts/verify-*`).

## Qué prueba (23 escenarios)

- Notas: organización, autor y fecha derivados por la base; GRANT de columna (el cliente no falsifica organización ni
  autor); RLS por rol (housekeeping y contabilidad no ven el CRM); cross-tenant; anon y sesión de sistema; minimización
  (rechaza 13 a 19 dígitos: tarjeta o documento); CHECK de longitud y tipo; archivar una sola vez sin reescribir ni borrar.
- ARCO: con cancelación u oposición no improcedente no se agregan notas; la bandera `guest_has_arco_restriction` devuelve
  solo un booleano, sin dar lectura de `arco_request`, y es falso para roles ajenos, otro tenant y anon.
- Cambio de habitación: asigna y registra bitácora; rechaza traslape con otra reserva activa (una cancelada o ya
  salida no cuenta); misma categoría; habitación fuera de servicio (marca o inhabilitación activa) o sucia con el
  huésped en casa; deja sucia la habitación anterior; estados no modificables; roles (solo owner/gm/frontdesk);
  otro tenant ve "no encontrada"; anon y sistema.
- Bitácora append-only (aun con superusuario), RLS y privilegios de las funciones (`security definer`, `search_path` fijo,
  sin EXECUTE para anon).

## Qué no prueba

La carrera real de dos sesiones asignando la misma habitación a la vez: el gate corre cada escenario en una sola
conexión. La serialización descansa en `pg_advisory_xact_lock` por habitación (mismo mecanismo que `book_availability`).
