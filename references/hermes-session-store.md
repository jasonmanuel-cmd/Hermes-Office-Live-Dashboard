# Hermes session store (SQLite)

Path (cipher profile, Windows):
  C:\Users\blunt\AppData\Local\hermes\profiles\cipher\state.db

ALWAYS open read-only so the dashboard can never corrupt the live store:
  const db = new DatabaseSync(path);
  db.exec('pragma query_only = on;');   // node:sqlite (Node >= 22.5, built-in)

Table `sessions` (key columns):
  id, title, source, model, message_count, tool_call_count,
  last_activity_at, last_activity_description, end_reason, pinned,
  started_at, git_repo_root

Table `messages` (key columns):
  id, session_id, role, content, tool_name, timestamp
  (content may be string OR JSON; coerce with JSON.stringify when not a string)

Gotcha — `last_activity_at` is NULL for ~374/405 open sessions. For age math
fall back to `started_at`, else every open session reads as "abandoned".

Activity heuristic (the library has no native streaming state):
  error  <- /error|fail|exception/
  writing<- /writ|edit|patch|creat|file/
  reading<- /read|search|fetch|brows|scan/
  waiting<- /wait|await|approv|input|stream/
  else thinking (open) / idle (ended)

Dry-run audit (read-only, no mutations):
  SELECT end_reason, last_activity_at, started_at FROM sessions;
  open   = end_reason IS NULL
  abandoned = open AND (now - (last_activity_at OR started_at))/3600 > STALE_H
Never auto-prune/archive — desktop-operator guardrail forbids deleting
pre-existing data without explicit approval.

Avoid `hermes sessions export` for polling: it dumps ~87 MB including full
transcripts. Query the SQLite store directly instead.
