# Cerebro de ventas (superadmin) -- SA-L-37, SA-L-38, SA-L-41

El cerebro PROPONE y el humano decide: nada de esto contacta a nadie. Migracion `0051_cerebro_ventas_base` (espejo
`supabase/migrations/20240101000291_0051_cerebro_ventas_base.sql`).

## Modelo de datos (SA-L-37)
- `core.prospecto` gana subtipo, tamano, ubicacion, sitio web, senales (jsonb con tipo, valor, fuente, url, observado_en),
  base de licitud + consentimiento, cuatro scores, explicacion y version del score, y seguimiento. Los prospectos con datos de
  contacto anteriores a la migracion quedan marcados `contacto_legado` ("sin base de licitud registrada: no contactar").
- `core.prospecto_contacto_persona`: CHECK que exige origen y evidencia (URL) para todo dato de contacto; no se aceptan correos
  deducidos por patron.
- `core.prospecto_evento`: linea de tiempo (toque saliente/entrante, cambio de etapa, nota, importacion, enriquecimiento).
- Funciones `*_for_superadmin` con caller-binding (`auth.uid() = p_caller_id` + `core.platform_superadmin`).

## Taxonomia por vertical (SA-L-38)
`core.cerebro_taxonomia` es versionada: editar NUNCA actualiza una fila, crea una version nueva y la anterior queda en el
historial. La semilla sale de la especificacion y esta marcada **propuesta, validar con Javier**. Los mensajes base son es-MX sin
promesas de cifras (guard en SQL y en el API). El precio se lee de `core.plan`; si es null se muestra "Precio por definir".
`PUT /superadmin/cerebro/taxonomia/:vertical` exige step-up (`SENSITIVE_ROUTES`).

## Scoring determinista (SA-L-41)
`apps/api/src/cerebro/scoring.ts`: sin LLM, reglas versionadas por vertical (ajuste ICP, urgencia, cierre, completitud). La
explicacion lista regla, puntos y evidencia (fuente y fecha) y suma exactamente el puntaje. Con menos de 3 senales: "SENAL
INSUFICIENTE: falta X, como conseguirlo". Se recalcula al crear o editar y guarda `score_version`.

## API y base sin migrar
`GET/POST/PUT /superadmin/cerebro/prospectos`, `GET .../:id/detalle`, `POST .../:id/personas`, `GET /superadmin/cerebro/taxonomia`,
`PUT /superadmin/cerebro/taxonomia/:vertical`. Con la base sin migrar responden 200 con `disponible:false` (SQLSTATE 42883, 42P01,
42703 dentro de SAVEPOINT) y la pagina sigue mostrando la lista de siempre con un aviso honesto.

## Mapa y ficha (SA-L-42, SA-L-43)
`/superadmin/mapa-prospectos` (menu Negocio) es el cerebro.tsx de Likida portado: pais -> estado (zoom animado) -> calles (Leaflet + racimos),
camara libre, latido cada 5 min (no con la pestana oculta), KPIs, filtros, busqueda, radio por plaza, exportacion CSV y pie con el criterio de los
scores; respeta `prefers-reduced-motion`. `/superadmin/mapa-prospectos/:id` es la ficha. **El color de cada luz, pin y racimo es el de su
vertical** (tokens `--vertical-*` de `packages/ui/src/index.css`, contraste verificado en `packages/ui/tests/tokens-vertical.spec.ts`); la leyenda
es el filtro por vertical; la etapa es filtro, dato de la tarjeta y anillo del pin (ganado resalta, perdido/descartado se apagan).
- La lista (`GET /superadmin/cerebro/prospectos`) trae por prospecto `suprimido` ({telefono, correo}) leido con `core.esta_suprimido` (solo de sistema)
  en una sesion de sistema propia y solo con hashes; si no se puede verificar, el campo falta y la pantalla NO ofrece contactar.
- `POST /superadmin/cerebro/exportaciones` registra la FORMA de la consulta y el total (bitacora de acceso, accion `exportacion`, migracion 0034) antes
  de armar el CSV; si registrar falla, no se exporta.
- WhatsApp/correo abren la app de quien opera con el mensaje base de la taxonomia; no se ofrecen sin base de licitud, con el destino suprimido o con
  marcadores sin resolver. Nada se manda solo.
- Sin SQL nuevo. Huecos declarados: registro del toque, redaccion con IA, envio con aprobaciones (SA-L-45) y la "necesidad"/flota/vacante de Likida.

## Fuera de alcance
Importador (SA-L-39) y redactor (SA-L-44).
