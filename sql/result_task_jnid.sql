-- Optional idempotency marker for create-result-task.js: stores the JN task id
-- of the "go back" result task so it isn't created twice. The function works
-- without this column (just no dedup), so this is safe to run anytime.
ALTER TABLE inspections ADD COLUMN IF NOT EXISTS result_task_jnid text;
