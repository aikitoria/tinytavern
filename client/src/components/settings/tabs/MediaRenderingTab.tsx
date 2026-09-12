import { entityOptions, editReferencedEntity } from '../../../state/entityReferences.ts';
import SettingsSection from '../SettingsSection.tsx';
import { SettingsDraftContext } from '../SettingsSection.tsx';
import { createMemo } from 'solid-js';
import {
  nextCollectionId,
  DEFAULT_MEDIA_RENDERING,
  compileMediaWorkflow,
  type MediaFavorite,
  type MediaWorkflowShortcut,
  settingsFields,
  settingsReference,
  settingsCollection,
  settingsText,
  importImagePromptSet,
  DEFAULT_SETTINGS,
  type SettingsFieldSchema,
} from '@tinytavern/shared';
import { state } from '../../../state/store.ts';
import { uniqueCollectionName } from '../../../state/collectionNames.ts';
import SettingsCollectionTable from '../SettingsCollectionTable.tsx';
import FormField from '../../forms/FormFields.tsx';
import { ImageGenerationSettingsFields } from '../../../images/imageGeneration.tsx';
import { mediaSettingsDraft } from './mediaSettingsDraft.tsx';

export default function MediaRenderingTab() {
  const form = mediaSettingsDraft();
  const configuredWorkflows = createMemo(() => form.draft().workflows);
  const workflows = createMemo(() => configuredWorkflows().filter((item) => item.json.trim()));
  const workflowOptions = createMemo(() => entityOptions('workflows', workflows()));
  const favoriteWorkflows = createMemo(() =>
    workflows().filter((workflow) => {
      try {
        if (workflow.textOutputNodeId !== null) return false;
        const compiled = compileMediaWorkflow(workflow.json);
        return compiled.slots.has('prompt') && compiled.mediaInputs.length === 0;
      } catch {
        return false;
      }
    }),
  );
  const presets = () => state.settings.mediaChatPrompts.presets;
  const patchShortcut = (id: string, fields: Partial<MediaWorkflowShortcut>) =>
    form.setDraft((current) => ({
      ...current,
      shortcuts: current.shortcuts.map((item) => (item.id === id ? { ...item, ...fields } : item)),
    }));
  const patchFavorite = (id: string, fields: Partial<MediaFavorite>) =>
    form.setFavorites((current) => current.map((item) => (item.id === id ? { ...item, ...fields } : item)));
  const workflowReference = settingsReference(() => configuredWorkflows());
  const entryFields = {
    name: settingsText,
    workflowId: settingsReference(() => configuredWorkflows(), false),
  };
  const schema: SettingsFieldSchema = {
    ...Object.fromEntries(
      Object.entries(
        settingsFields(
          {
            comfyUrl: DEFAULT_MEDIA_RENDERING.comfyUrl,
            jobTimeoutSeconds: DEFAULT_MEDIA_RENDERING.jobTimeoutSeconds,
            defaultWorkflowId: null,
            avatarWorkflowId: null,
            descriptionWorkflowId: null,
          },
          {
            defaultWorkflowId: workflowReference,
            avatarWorkflowId: workflowReference,
            descriptionWorkflowId: workflowReference,
          },
        ),
      ).map(([key, codec]) => [`mediaRendering.${key}`, codec]),
    ),
    'mediaRendering.shortcuts': settingsCollection(entryFields, () => ({
      name: '',
      workflowId: '',
    })),
    mediaFavorites: settingsCollection({ ...entryFields, presetId: settingsReference(presets, false) }, () => ({
      name: '',
      workflowId: '',
      presetId: '',
    })),
    ...Object.fromEntries(
      Object.entries(DEFAULT_SETTINGS.imageGeneration)
        .filter(([, value]) => typeof value === 'string')
        .map(([key]) => [`imageGeneration.${key}`, settingsText]),
    ),
    'imageGeneration.promptPresets.avatar': {
      encode: (value) => value,
      decode: (value, current) =>
        importImagePromptSet(value, current as Parameters<typeof importImagePromptSet>[1], true),
    },
  };
  return (
    <SettingsDraftContext.Provider
      value={{
        schema,
        read: form.readDraft,
        write: (next) => form.writeDraft(next as ReturnType<typeof form.readDraft>),
        onError: form.setError,
      }}
    >
      <div class="form [&_label]:text-label [&_label]:text-foreground [&_label]:mt-2">
        <SettingsSection
          title="Connection"
          id="media-connection"
          fields={['mediaRendering.comfyUrl', 'mediaRendering.jobTimeoutSeconds']}
        >
          <FormField
            label="ComfyUI URL"
            value={form.draft().comfyUrl}
            defaultValue={DEFAULT_MEDIA_RENDERING.comfyUrl}
            onChange={(comfyUrl) => form.setDraft((value) => ({ ...value, comfyUrl }))}
          />
          <FormField
            label="Maximum job time (seconds)"
            kind="number"
            min="0"
            max="86400"
            value={form.draft().jobTimeoutSeconds}
            defaultValue={0}
            onChange={(jobTimeoutSeconds) =>
              form.setDraft((value) => ({ ...value, jobTimeoutSeconds: jobTimeoutSeconds || 0 }))
            }
            hint="0 means no time limit. A limit of 60–86400 seconds includes queue time. Prompt preparation has a separate inactivity timeout."
          />
        </SettingsSection>
        <SettingsSection
          title="Defaults"
          id="media-defaults"
          fields={[
            'mediaRendering.defaultWorkflowId',
            'mediaRendering.avatarWorkflowId',
            'mediaRendering.descriptionWorkflowId',
          ]}
        >
          <FormField
            label="Generator workflow"
            value={form.draft().defaultWorkflowId ?? ''}
            defaultValue=""
            options={[{ value: '', label: 'Choose in the generator' }, ...workflowOptions()]}
            onChange={(value) => form.setDraft((current) => ({ ...current, defaultWorkflowId: value || null }))}
          />
          <FormField
            label="Avatar workflow"
            value={form.draft().avatarWorkflowId ?? ''}
            defaultValue=""
            options={[
              {
                value: '',
                label: 'Same as generator',
                edit: form.draft().defaultWorkflowId
                  ? () => editReferencedEntity('workflows', form.draft().defaultWorkflowId!)
                  : undefined,
              },
              ...workflowOptions(),
            ]}
            onChange={(value) => form.setDraft((current) => ({ ...current, avatarWorkflowId: value || null }))}
            hint="The result must be an image to use it as an avatar."
          />
          <FormField
            label="Image description workflow"
            value={form.draft().descriptionWorkflowId ?? ''}
            defaultValue=""
            options={[
              { value: '', label: 'None' },
              ...entityOptions(
                'workflows',
                workflows().filter((item) => item.textOutputNodeId !== null),
              ),
            ]}
            onChange={(value) => form.setDraft((current) => ({ ...current, descriptionWorkflowId: value || null }))}
          />
        </SettingsSection>
        <SettingsSection title="Generator shortcuts" id="generator-shortcuts" fields={['mediaRendering.shortcuts']}>
          <p class="hint">Open the generator with a selected workflow, then edit inputs and generate.</p>
          <SettingsCollectionTable
            items={form.draft().shortcuts}
            onReorder={(shortcuts) => form.setDraft((current) => ({ ...current, shortcuts }))}
            columns={[
              {
                label: 'Name',
                value: (item) => item.name,
                onChange: (item, name) => patchShortcut(item.id, { name }),
              },
              {
                label: 'Workflow',
                value: (item) => item.workflowId,
                options: workflowOptions(),
                searchPlaceholder: 'Search workflows…',
                onChange: (item, workflowId) => patchShortcut(item.id, { workflowId }),
              },
            ]}
            onRemove={(shortcut) =>
              form.setDraft((value) => ({
                ...value,
                shortcuts: value.shortcuts.filter((item) => item.id !== shortcut.id),
              }))
            }
          />
          <button
            disabled={!workflows().length}
            onClick={() =>
              form.setDraft((value) => ({
                ...value,
                shortcuts: [
                  ...value.shortcuts,
                  {
                    id: nextCollectionId(value.shortcuts),
                    name: uniqueCollectionName('New shortcut', value.shortcuts),
                    workflowId: workflows()[0]!.id,
                  },
                ],
              }))
            }
          >
            Add shortcut
          </button>
        </SettingsSection>
        <SettingsSection title="Toolbar favorites" id="toolbar-favorites" fields={['mediaFavorites']}>
          <p class="hint">
            Prepare the selected prompt using the conversation and run the workflow immediately. Workflows must have a
            prompt input and no media inputs.
          </p>
          <SettingsCollectionTable
            items={form.favorites()}
            onReorder={(items) => form.setFavorites(() => items)}
            columns={[
              {
                label: 'Name',
                value: (item) => item.name,
                onChange: (item, name) => patchFavorite(item.id, { name }),
              },
              {
                label: 'Chat prompt preset',
                value: (item) => item.presetId,
                options: entityOptions('mediaChatPrompts', presets()),
                searchPlaceholder: 'Search prompts…',
                onChange: (item, presetId) => patchFavorite(item.id, { presetId }),
              },
              {
                label: 'Workflow',
                value: (item) => item.workflowId,
                options: entityOptions('workflows', favoriteWorkflows()),
                searchPlaceholder: 'Search workflows…',
                onChange: (item, workflowId) => patchFavorite(item.id, { workflowId }),
              },
            ]}
            onRemove={(favorite) => form.setFavorites((items) => items.filter((item) => item.id !== favorite.id))}
          />
          <div class="flex gap-2">
            <button
              disabled={!favoriteWorkflows().length || !presets().length}
              onClick={() =>
                form.setFavorites((items) => [
                  ...items,
                  {
                    id: nextCollectionId(items),
                    name: uniqueCollectionName('New favorite', items),
                    workflowId: favoriteWorkflows()[0]!.id,
                    presetId: presets()[0]!.id,
                  },
                ])
              }
            >
              Add favorite
            </button>
          </div>
        </SettingsSection>
        <ImageGenerationSettingsFields ref={form.setImageFields} onError={form.setError} />
        <form.Actions />
      </div>
    </SettingsDraftContext.Provider>
  );
}
