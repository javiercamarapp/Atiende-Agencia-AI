# verify-bundle-budget (R-37)

Presupuesto de JS por ruta del front (`apps/web`), medido en bytes gzip sobre el build real.
Para cada ruta de `budget.json` suma el chunk de la ruta y todos sus imports estaticos transitivos
(lo que el navegador descarga antes de pintarla; los `dynamicImports` son otras rutas y no cuentan).
Incluye las pantallas publicas del storefront que abre el cliente final desde el celular.

    npm run build --workspace apps/web
    npm run verify:bundle-budget

Requiere `build.manifest: true` (un plugin de `apps/web/vite.config.ts` lo mueve a `apps/web/bundle-manifest.json`, fuera de dist) en `apps/web/vite.config.ts`. Corre en CI justo despues del build.
Si un tope falla: primero busca el import estatico que arrastro codigo de otra ruta; subir el tope es
el ultimo recurso y debe justificarse en el PR. Antes de R-37 todo el panel iba en un solo bundle de
2.87 MB (756 KiB gzip); ahora la entrada es ~145 KiB gzip.
