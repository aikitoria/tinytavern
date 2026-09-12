/** Media libraries are entities; JSON columns contain payloads, never collections or identities. */
const folder = (name: string) => `CREATE TABLE ${name} (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL COLLATE NOCASE UNIQUE,
  created_at INTEGER NOT NULL
);`;
const prompt = (name: string, columns: string) => `CREATE TABLE ${name} (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  folder_id INTEGER REFERENCES ${name}_folders(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  ${columns},
  created_at INTEGER NOT NULL,
  deleted_at INTEGER,
  revision INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX ${name}_name ON ${name}(name COLLATE NOCASE) WHERE deleted_at IS NULL;
CREATE INDEX ${name}_folder ON ${name}(folder_id) WHERE folder_id IS NOT NULL;`;

export const MEDIA_ENTITY_SCHEMA = `
${folder('media_workflow_folders')}
${folder('media_chat_prompts_folders')}
${folder('media_standalone_prompts_folders')}
${folder('avatar_prompts_folders')}
${prompt('media_chat_prompts', "chat_prompt TEXT NOT NULL DEFAULT ''")}
${prompt('media_standalone_prompts', "system_prompt TEXT NOT NULL DEFAULT '', user_message TEXT NOT NULL DEFAULT '', reasoning_prefill TEXT NOT NULL DEFAULT '', message_prefill TEXT NOT NULL DEFAULT ''")}
${prompt('avatar_prompts', "prompt TEXT NOT NULL DEFAULT '', context TEXT NOT NULL DEFAULT ''")}
CREATE TABLE media_workflows (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  folder_id INTEGER REFERENCES media_workflow_folders(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  json TEXT NOT NULL DEFAULT '',
  input_bindings_json TEXT NOT NULL DEFAULT '{}',
  standalone_prompt_preset_id INTEGER REFERENCES media_standalone_prompts(id),
  chat_prompt_preset_id INTEGER REFERENCES media_chat_prompts(id),
  text_output_node_id TEXT,
  created_at INTEGER NOT NULL,
  deleted_at INTEGER,
  revision INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX media_workflows_name ON media_workflows(name COLLATE NOCASE) WHERE deleted_at IS NULL;
CREATE INDEX media_workflows_folder ON media_workflows(folder_id) WHERE folder_id IS NOT NULL;
CREATE TABLE media_shortcuts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  workflow_id INTEGER NOT NULL REFERENCES media_workflows(id),
  position INTEGER NOT NULL DEFAULT 0,
  revision INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE media_favorites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  workflow_id INTEGER NOT NULL REFERENCES media_workflows(id),
  preset_id INTEGER NOT NULL REFERENCES media_chat_prompts(id),
  position INTEGER NOT NULL DEFAULT 0,
  revision INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE media_selections (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  default_workflow_id INTEGER REFERENCES media_workflows(id),
  avatar_workflow_id INTEGER REFERENCES media_workflows(id),
  description_workflow_id INTEGER REFERENCES media_workflows(id),
  chat_prompt_id INTEGER REFERENCES media_chat_prompts(id),
  standalone_prompt_id INTEGER REFERENCES media_standalone_prompts(id),
  avatar_prompt_id INTEGER REFERENCES avatar_prompts(id)
);
CREATE INDEX media_workflows_chat_prompt ON media_workflows(chat_prompt_preset_id) WHERE chat_prompt_preset_id IS NOT NULL;
CREATE INDEX media_workflows_standalone_prompt ON media_workflows(standalone_prompt_preset_id) WHERE standalone_prompt_preset_id IS NOT NULL;
CREATE INDEX media_shortcuts_workflow ON media_shortcuts(workflow_id);
CREATE INDEX media_favorites_workflow ON media_favorites(workflow_id);
CREATE INDEX media_favorites_preset ON media_favorites(preset_id);
INSERT INTO media_selections(id) VALUES(1);
`;

/** Applied after rebuilding jobs and adding the recipe reference during an upgrade. */
export const MEDIA_REFERENCE_INDEXES = `
CREATE INDEX media_jobs_workflow ON media_jobs(workflow_id) WHERE workflow_id IS NOT NULL;
CREATE INDEX media_jobs_chat_prompt ON media_jobs(chat_preset_id) WHERE chat_preset_id IS NOT NULL;
CREATE INDEX media_jobs_standalone_prompt ON media_jobs(standalone_preset_id) WHERE standalone_preset_id IS NOT NULL;
CREATE INDEX media_recipes_workflow ON media_recipes(workflow_id) WHERE workflow_id IS NOT NULL;
`;
