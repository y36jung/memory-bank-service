-- Custom SQL migration file, put your code below! --
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_replication_slots WHERE slot_name = 'outbox_slot'
  ) THEN
    PERFORM pg_create_logical_replication_slot('outbox_slot', 'pgoutput');
  END IF;
END
$$;

CREATE PUBLICATION IF NOT EXISTS outbox_pub FOR TABLE outbox;
