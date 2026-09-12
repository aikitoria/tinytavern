import SettingsSection from '../SettingsSection.tsx';
import { createMemo, createSignal } from 'solid-js';
import { unwrap } from 'solid-js/store';
import {
  exportWorkflow,
  importWorkflow,
  exportWorkflowLibrary,
  importWorkflowLibrary,
  settingsFields,
  settingsReference,
  settingsDictionary,
  settingsText,
  type MediaWorkflow,
} from '@tinytavern/shared';
import { state } from '../../../state/store.ts';
import { mediaEntityEditor } from '../../../state/mediaEntityEditor.ts';
import { settingsCollection } from './settingsCollection.ts';
import { createEntityEditor } from '../../../util.ts';
import { useSettingsNavigation } from '../SettingsGuard.tsx';
import EntityEditorPane from '../EntityEditorPane.tsx';
import SettingsTransferButtons from '../SettingsTransferButtons.tsx';
import { createFolderBrowser } from '../FolderEntityList.tsx';
import FormField from '../../forms/FormFields.tsx';
import WorkflowFields, { WorkflowSetupHelp } from './WorkflowFields.tsx';

type WorkflowItem = MediaWorkflow & { folderId: string | null };
const blank = (): WorkflowItem => ({
  id: '',
  name: '',
  json: '',
  folderId: null,
  inputBindings: {},
  textOutputNodeId: null,
  chatPromptPresetId: null,
  standalonePromptPresetId: null,
});

export default function WorkflowsTab() {
  const [draft, setDraft] = createSignal(blank());
  const folderMap = createMemo(
    () =>
      new Map(
        state.settings.mediaRendering.folders.flatMap((folder) =>
          folder.workflowIds.map((id) => [id, folder.id] as const),
        ),
      ),
  );
  const items = createMemo(() =>
    state.settings.mediaRendering.workflows.map((workflow): WorkflowItem => ({
      ...workflow,
      folderId: folderMap().get(workflow.id) ?? null,
    })),
  );
  const update = settingsCollection('mediaRendering');
  const entity = mediaEntityEditor<WorkflowItem>('workflows', items);
  const editor = createEntityEditor({
    items,
    initialId: () => state.settings.mediaRendering.defaultWorkflowId,
    load: (item) => setDraft(structuredClone(unwrap(item ?? blank()))),
    data: () => {
      const { id, ...fields } = draft();
      return fields;
    },
    ...entity,
    deletePrompt: 'Delete this workflow?',
  });
  const folders = createFolderBrowser({
    items,
    folders: () => state.settings.mediaRendering.folders,
    folderId: (item) => item.folderId,
    selectedId: editor.selectedId,
    select: editor.select,
    label: (item) => item.name,
    noun: 'workflows',
    ...entity.folders,
    onError: editor.setStatus,
  });
  const navigate = useSettingsNavigation();
  return (
    <>
      <EntityEditorPane
        editor={editor}
        sectionSchema={settingsFields(
          { ...blank() },
          {
            folderId: settingsReference(() => state.settings.mediaRendering.folders),
            chatPromptPresetId: settingsReference(() => state.settings.mediaChatPrompts.presets),
            standalonePromptPresetId: settingsReference(
              () => state.settings.mediaStandalonePrompts.presets,
            ),
            inputBindings: settingsDictionary(settingsDictionary(settingsText)),
          },
        )}
        items={items()}
        itemLabel={(item) => item.name}
        newLabel="New"
        folderBrowser={folders}
        listFooter={
          <SettingsTransferButtons
            type="page:workflows"
            importLabel="Import all"
            exportLabel="Export all"
            onError={editor.setStatus}
            exportData={() => exportWorkflowLibrary(state.settings)}
            importData={(data) =>
              navigate(() => {
                void update((current) => ({
                  ...current,
                  ...importWorkflowLibrary(data, { ...state.settings, mediaRendering: current }),
                }))
                  .then(() => editor.setStatus('Workflows imported.', 'success'))
                  .catch((err) =>
                    editor.setStatus(String(err instanceof Error ? err.message : err)),
                  );
              })
            }
          />
        }
        formActions={
          <SettingsTransferButtons
            type="workflow"
            onError={editor.setStatus}
            exportData={() => exportWorkflow(draft(), state.settings)}
            importData={(data) => {
              const workflow = importWorkflow(data, [], state.settings);
              editor.importData({ ...workflow, id: draft().id });
            }}
          />
        }
      >
        <WorkflowSetupHelp />
        <SettingsSection
          title="Workflow"
          id="workflow"
          fields={[
            'name',
            'folderId',
            'json',
            'inputBindings',
            'textOutputNodeId',
            'chatPromptPresetId',
            'standalonePromptPresetId',
          ]}
        >
          <FormField
            label="Name"
            value={draft().name}
            defaultValue=""
            onChange={(name) => setDraft((value) => ({ ...value, name }))}
          />
          <FormField
            label="Folder"
            ariaLabel="Workflow folder"
            value={draft().folderId ?? ''}
            defaultValue=""
            options={[{ value: '', label: 'Root' }, ...folders.options()]}
            onChange={(folderId) => setDraft((value) => ({ ...value, folderId: folderId || null }))}
          />
          <WorkflowFields
            workflow={draft()}
            onChange={(fields) => setDraft((value) => ({ ...value, ...fields }))}
          />
        </SettingsSection>
      </EntityEditorPane>
    </>
  );
}
