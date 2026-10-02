# verify-hoteles-fechas-lista-espera

Verificación contra Postgres REAL (mismo patrón que `scripts/verify-hoteles-recepcion-ficha/`) de
`packages/domain-hoteles/migrations/041_hoteles_cambio_fechas_lista_espera.sql` (H-28 cambio de fechas, seguimientos de #302 y
H-12 lista de espera).

```
scripts/verify-hoteles-fechas-lista-espera/run.sh        # manual, Postgres efímero local
node scripts/verify-real-postgres-ci/run-gate.mjs scripts/verify-hoteles-fechas-lista-espera
```

En CI lo ejecuta automáticamente el gate `Postgres real` (auto-descubre `scripts/verify-*`).

## Qué prueba (23 escenarios)

- Cambio de fechas (`hoteles.change_reservation_dates`): extender, mover llegada y salida, inventario por noche (solo se
  reservan/liberan las noches que cambian), sin cupo (P0001) revierte TODO, dos cambios compiten por la última habitación
  (el segundo no sobrevende), fechas esperadas desactualizadas (55006), huésped en casa (la llegada no cambia; las noches ya
  posteadas por el night-audit no se tocan), estados no modificables, parámetros inválidos, traslape de habitación asignada,
  roles (housekeeping y contabilidad 42501), cross-tenant (P0002), anon y sesión de sistema, bitácora append-only con RLS.
- `change_reservation_room` redefinida con la membresía antes de bloquear: otro tenant P0002, roles ajenos 42501, anon/sistema.
- Lista de espera (`hoteles.waitlist_entry`): organización/autor/estado derivados por la base, GRANT de columna, tipo de
  habitación de otra property (22023), CHECK de contacto/fechas/nombre/huéspedes, RLS por rol y tenant, anon y sistema,
  transiciones (activa -> ofrecida -> aceptada; vencimiento entre ahora y 7 días; no se acepta una oferta vencida; solo se
  expira una oferta ya vencida), sin DELETE ni reescritura de datos.
- Privilegios de las funciones (sin EXECUTE para anon, `security definer`, `search_path` fijo).

## Qué no prueba

La carrera real de dos sesiones a la vez (el gate corre cada escenario en una sola conexión): la serialización descansa en
`for update` sobre la reserva y en los advisory locks de `book_availability`/`release_availability`, que recorren las noches
en orden ascendente. El escenario 4 verifica el resultado secuencial (no sobreventa).
