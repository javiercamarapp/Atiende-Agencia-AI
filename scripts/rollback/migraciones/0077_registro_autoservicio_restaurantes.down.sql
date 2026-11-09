-- Reversa manual de packages/db/migrations/0077_registro_autoservicio_restaurantes.sql (ver docs/ROLLBACK.md).
-- Quita el registro autoservicio de restaurantes: la API responde 503 honesto («no disponible aún») al no encontrar las funciones.
-- Las organizaciones, cuentas y sucursales ya creadas NO se borran: son organizaciones normales en prueba.
drop function if exists core.registro_autoservicio_completar(text, text);
drop function if exists core.registro_autoservicio_solicitar(text, text, text, text, text, text, text, text, text, integer);
drop table if exists core.registro_autoservicio_solicitud;
