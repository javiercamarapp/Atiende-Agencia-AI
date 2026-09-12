-- Escritura atómica de conversation_state con compare-and-swap por versión.
--
-- Extiende el patrón real de atiende.ai
-- (supabase/migrations/set_conversation_state_rpc.sql, que usa jsonb_set para
-- evitar el race read-modify-write en código de aplicación) agregando un
-- chequeo de versión dentro de la misma transacción implícita del UPDATE:
-- si `version` en la fila no coincide con `p_expected_version`, el UPDATE no
-- toca ninguna fila y la función retorna FALSE — el caller sabe exactamente
-- que perdió la carrera, sin haber aplicado nada parcial.
--
-- Requiere: tabla `conversations` con columna `metadata JSONB`.
-- Schema del campo: metadata.conversation_state = { state, context, version }

CREATE OR REPLACE FUNCTION get_conversation_state(
  p_conversation_id UUID,
  p_table TEXT DEFAULT 'conversations'
)
RETURNS JSONB AS $$
DECLARE
  v_metadata JSONB;
BEGIN
  EXECUTE format('SELECT metadata FROM %I WHERE id = $1', p_table)
    INTO v_metadata
    USING p_conversation_id;

  IF v_metadata IS NULL THEN
    RETURN NULL;
  END IF;

  RETURN COALESCE(
    v_metadata->'conversation_state',
    jsonb_build_object('state', NULL, 'context', '{}'::JSONB, 'version', 0)
  );
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION set_conversation_state_cas(
  p_conversation_id UUID,
  p_expected_version INT,
  p_state TEXT,          -- NULL para volver a reposo
  p_context JSONB DEFAULT '{}'::JSONB,
  p_table TEXT DEFAULT 'conversations'
)
RETURNS BOOLEAN AS $$
DECLARE
  v_rows_updated INT;
  v_new_value JSONB;
BEGIN
  v_new_value := jsonb_build_object(
    'state', p_state,
    'context', p_context,
    'version', p_expected_version + 1
  );

  -- El WHERE compara la versión ACTUAL en la fila contra la esperada por el
  -- caller. Si otra transacción ya escribió (version cambió), el UPDATE
  -- afecta 0 filas — Postgres garantiza que este chequeo y el UPDATE son
  -- atómicos entre sí (misma sentencia), así que no hay ventana de carrera
  -- entre "leer versión" y "escribir" como sí la había en el código de
  -- aplicación del read-modify-write original.
  EXECUTE format(
    'UPDATE %I
       SET metadata = jsonb_set(
         COALESCE(metadata, ''{}''::JSONB),
         ''{conversation_state}'',
         $1
       )
     WHERE id = $2
       AND COALESCE((metadata->''conversation_state''->>''version'')::INT, 0) = $3',
    p_table
  )
  USING v_new_value, p_conversation_id, p_expected_version;

  GET DIAGNOSTICS v_rows_updated = ROW_COUNT;
  RETURN v_rows_updated = 1;
END;
$$ LANGUAGE plpgsql;
