# verify-notificaciones-productor

Postgres **real** (el gate de CI `scripts/verify-real-postgres-ci/run-gate.mjs` lo descubre solo): migración
`packages/db/migrations/0039_notificaciones_productor_dedupe.sql` (espejo en `supabase/migrations/`).

Cubre `core.emit_notification` (productor único), `core.list_notifications_v2_for_staff` y
`core.count_unread_notifications_v2_for_staff`:

- **Destinatarios**: owner/admin de la organización + roles de vertical pedidos; filtro por propiedad; plataforma →
  solo `core.platform_superadmin`; el vertical se deriva de la organización.
- **Idempotencia**: misma clave de dedupe = no-op (segunda llamada devuelve 0); la clave es obligatoria.
- **Validación en la base**: tipo, categoría, severidad, enlace solo ruta interna relativa (rechaza esquema y `//`),
  propiedad de otra organización; la validación corre aunque no haya destinatarios.
- **Volumen y retención**: tope de 100 por destinatario por hora; las vencidas del destinatario se depuran al emitir.
- **Autorización de emisión**: sistema (sin `auth.uid()`) o miembro de la propia organización; un miembro de A no
  emite a B (cross-tenant), un usuario sin membresía no emite, un no-superadmin no emite de plataforma, `anon` no
  ejecuta.
- **Lectura / RLS**: solo el propio usuario (otro usuario y la sesión de sistema reciben cero filas); estado leído
  por usuario (marcar a uno no apaga a otro); filtros de no leídas y categoría; límite; vencidas excluidas;
  compatibilidad con las funciones de 0013; tabla sin acceso directo; sin GRANT a `anon`/`public`;
  `search_path` fijo en las tres funciones `security definer`.

Manual: `scripts/verify-notificaciones-productor/run.sh` (initdb/pg_ctl local).
