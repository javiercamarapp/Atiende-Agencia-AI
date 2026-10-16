-- ---------------------------------------------------------------------------
-- Rentas 034 (paridad3, Rn-P3-21): las senales de escalamiento del borrador se guardan.
--
-- Hasta ahora el generador (plantillas o IA) devolvia `necesitaEscalamiento` y `senales`
-- (queja, emergencia, reembolso, vip) solo en la respuesta de la generacion: al recargar la
-- bandeja el dato se perdia y una emergencia quedaba mezclada con borradores rutinarios.
-- Esta migracion agrega las dos columnas a rentas.borrador_mensaje para persistirlas.
--
-- Cambios:
--   1. necesita_escalamiento boolean not null default false  -- los borradores existentes y los que
--      crea la funcion de sistema rentas.sistema_crear_borrador_automatico (plantilla propia del
--      tenant, sin texto de huesped) quedan en false: es el valor correcto, no un relleno.
--   2. senales text[] not null default '{}' -- con CHECK: solo los 4 codigos del dominio y coherencia
--      con la bandera (una senal implica necesita_escalamiento).
--
-- Seguridad (cada GRANT / policy / funcion nueva lleva su justificacion):
--   * No se crea tabla, funcion ni policy: las policies de 009 (RLS por rentas.conversacion ->
--     core.has_property_access) siguen cubriendo las columnas nuevas. Sin cambios para anon.
--   * GRANT: 009 dio `update` a nivel de TABLA a authenticated, lo que habria dejado a cualquier
--     staff de la property editar tambien las columnas nuevas (por ejemplo apagar la marca de una
--     emergencia). Las funciones reales solo escriben, al aprobar/rechazar/auditar, estas columnas:
--     estado, texto, redactado, aprobado_por, aprobado_en, rechazado_por, rechazado_en,
--     motivo_rechazo, mensaje_enviado_id y actualizado_en. Por eso se revoca el update de tabla y se
--     concede por COLUMNA solo esa lista; las dos columnas nuevas quedan insert-only (el insert de
--     tabla de 009 ya las cubre) para authenticated. service_role conserva todo (sin cambios).
--   * Compatibilidad con la base sin migrar: el codigo TypeScript que lee estas columnas captura
--     42703 y degrada a false / [] (ver postgres-repository.ts).
-- ---------------------------------------------------------------------------
alter table rentas.borrador_mensaje
  add column necesita_escalamiento boolean not null default false,
  add column senales text[] not null default '{}';

alter table rentas.borrador_mensaje
  add constraint borrador_mensaje_senales_validas
    check (senales <@ array['queja', 'emergencia', 'reembolso', 'vip']::text[]),
  add constraint borrador_mensaje_senales_implican_escalamiento
    check (cardinality(senales) = 0 or necesita_escalamiento);

-- Bandeja: los escalados pendientes se listan primero.
create index borrador_mensaje_escalados_pendientes_idx
  on rentas.borrador_mensaje (conversacion_id)
  where estado = 'pendiente_aprobacion' and necesita_escalamiento;

revoke update on rentas.borrador_mensaje from authenticated;
grant update (estado, texto, redactado, aprobado_por, aprobado_en, rechazado_por, rechazado_en, motivo_rechazo, mensaje_enviado_id, actualizado_en)
  on rentas.borrador_mensaje to authenticated;
