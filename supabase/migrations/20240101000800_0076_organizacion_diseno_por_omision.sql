-- Diseno nuevo por omision (rediseno ds3, fase de retiro del diseno anterior).
--
-- Que cambia: el default de core.organization.diseno (0060) pasa de NULL a 'ds3', para que toda organizacion nueva nazca con el diseno
-- nuevo, y las filas que aun tengan NULL se llevan a 'ds3'. El check de 0060 no cambia ('ds3' ya es valido). La columna se conserva por
-- ahora: el web ya pinta ds3 para todos sin leerla (el unico interruptor es de build, VITE_DISENO_LEGADO=1) y se retirara despues en una
-- migracion aparte, cuando ningun codigo desplegado la lea.
--
-- Justificacion de seguridad:
--   * Solo una columna de presentacion, sin PII ni datos de negocio. No se agrega ningun GRANT, policy ni funcion; nadie gana lectura ni
--     escritura nueva (se conservan el grant y la policy descritos en 0060).
--
-- Compatibilidad: aditiva e idempotente. `set default` es solo catalogo (no reescribe la tabla); el update toca solo las filas con NULL
-- (hoy ninguna en produccion: las 8 organizaciones ya tienen 'ds3'). Aplicarla antes o despues del codigo es seguro: la API sigue
-- leyendo la columna igual que con 0060.
--
-- Reversa: alter table core.organization alter column diseno drop default; (las filas actualizadas se quedan en 'ds3', que es lo vigente).

alter table core.organization
  alter column diseno set default 'ds3';

update core.organization
   set diseno = 'ds3'
 where diseno is null;

comment on column core.organization.diseno is
  'Diseno del panel de la organizacion: ''ds3'' (diseno nuevo, por omision). Solo presentacion; se retirara con el diseno anterior.';
