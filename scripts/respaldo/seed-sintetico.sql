-- seed-sintetico.sql — datos 100% FICTICIOS para el drill sintético (CI y pruebas).
-- Se aplica sobre una base efímera con TODAS las migraciones ya corridas. No contiene
-- nada derivado de producción. Basta con que cada esquema de verticales con tablas de
-- datos tenga filas para que "conteos por tabla" sea una comprobación con sentido.
insert into core.organization (vertical, name, slug)
select v, 'Org sintética ' || v, 'sintetica-' || v
from unnest(array['hoteles','restaurantes','rentas','licitaciones','citas','despachos']) as v;

insert into citas.services (organization_id, name, duration_minutes, price_cents)
select o.id, 'Servicio sintético ' || g, 30 + g, 10000 + g
from core.organization o, generate_series(1, 5) g
where o.vertical = 'citas';
