-- Fan-out of change hints through PostgreSQL LISTEN/NOTIFY, so every server instance can serve SSE.
-- The notification is queued inside the writing transaction and delivered only if it commits,
-- so a hint never announces a change that was rolled back. It carries no content.
CREATE FUNCTION thoth_notify_changes() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('thoth_changes', json_build_object('w', workspace_id, 's', max_seq)::text)
    FROM (SELECT workspace_id, max(seq) AS max_seq FROM new_rows GROUP BY workspace_id) AS heads;
  RETURN NULL;
END;
$$;
CREATE TRIGGER changes_notify
  AFTER INSERT ON changes
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION thoth_notify_changes();
