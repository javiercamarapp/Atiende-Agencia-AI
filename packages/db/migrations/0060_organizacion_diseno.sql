-- Bandera de diseno POR ORGANIZACION (rediseno ds3).
--
-- Que agrega: core.organization.diseno text NULL, con check (null o 'ds3').
--   * NULL (default, todas las filas existentes) = diseno actual: nada cambia para ninguna organizacion.
--   * 'ds3' = el panel de esa organizacion se pinta con el diseno nuevo (la API lo expone en `organizations[].diseno` de la sesion y el
--     shell de la vertical pone html[data-diseno="ds3"] y lo recuerda para que /theme-boot.js lo pinte desde el primer cuadro).
--
-- Justificacion de seguridad:
--   * Solo una columna de presentacion, sin PII ni datos de negocio. No se agrega ningun GRANT, policy ni funcion: la columna hereda el
--     `grant select` a nivel tabla de 0001 y la policy "staff ve su propia organizacion" de 0015 (un staff solo lee la fila de SU
--     organizacion; la sesion de sistema del login, todas). Nadie gana escritura nueva: `authenticated` sigue sin UPDATE sobre
--     core.organization; la cambia solo el dueno de la plataforma con SQL (service_role) o una ruta futura de superadmin.
--   * El check limita los valores a la lista conocida: un valor desconocido nunca llega al navegador.
--
-- Compatibilidad: aditiva (add column ... null, sin default que reescriba la tabla). La API lee la columna aparte, dentro de un SAVEPOINT, y
-- ante 42703 (base sin migrar) responde `diseno: null`; aplicarla antes o despues del codigo es seguro.
--
-- Reversa: alter table core.organization drop column if exists diseno;

alter table core.organization
  add column if not exists diseno text null
  constraint organization_diseno_valido check (diseno is null or diseno in ('ds3'));

comment on column core.organization.diseno is
  'Diseno del panel de la organizacion: NULL = actual; ''ds3'' = rediseno nuevo. Solo presentacion.';
