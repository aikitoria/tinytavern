import SettingsSection from '../SettingsSection.tsx';
import { createMemo, createSignal } from 'solid-js';
import { unwrap } from 'solid-js/store';
import {
  nextCollectionId,
  exportWorkflow,
  importWorkflow,
  exportWorkflowLibrary,
  importWorkflowLibrary,
  namedItem,
  settingsFields,
  settingsReference,
  settingsDictionary,
  settingsText,
  type MediaWorkflow,
} from '@tinytavern/shared';
import { state } from '../../../state/store.ts';
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
  const write = async (
    id: string,
    data: Partial<WorkflowItem>,
    creating = false,
  ): Promise<WorkflowItem> => {
    const next = await update((current) => {
      const existing = current.workflows.find((item) => item.id === id);
      if (!creating && !existing)
        throw new Error('This workflow was deleted. Discard to continue.');
      const { folderId: _unused, ...empty } = blank();
      const { folderId, ...fields } = data;
      const workflow = { ...empty, ...existing, ...fields, id };
      const workflows = creating
        ? [...current.workflows, workflow]
        : current.workflows.map((item) => (item.id === id ? workflow : item));
      if (folderId && !current.folders.some((folder) => folder.id === folderId))
        throw new Error('The selected folder no longer exists');
      const folders =
        folderId === undefined
          ? current.folders
          : current.folders.map((folder) => ({
              ...folder,
              workflowIds:
                folder.id === folderId
                  ? [...folder.workflowIds.filter((value) => value !== id), id]
                  : folder.workflowIds.filter((value) => value !== id),
            }));
      return { ...current, workflows, folders };
    });
    return {
      ...next.workflows.find((item) => item.id === id)!,
      folderId: next.folders.find((folder) => folder.workflowIds.includes(id))?.id ?? null,
    };
  };
  const editor = createEntityEditor({
    items,
    initialId: () => state.settings.mediaRendering.defaultWorkflowId,
    load: (item) => setDraft(structuredClone(unwrap(item ?? blank()))),
    data: () => {
      const { id, ...fields } = draft();
      return fields;
    },
    create: (data) => write(nextCollectionId(state.settings.mediaRendering.workflows), data, true),
    patch: (id, data) => write(id, data),
    duplicate: async (id) => {
      const source = items().find((item) => item.id === id);
      if (!source) throw new Error('The workflow no longer exists');
      let name = `${source.name} (copy)`;
      for (let index = 2; namedItem(items(), name); index++)
        name = `${source.name} (copy ${index})`;
      return write(nextCollectionId(items()), { ...source, name }, true);
    },
    remove: async (id) => {
      await update((current) => ({
        ...current,
        workflows: current.workflows.filter((item) => item.id !== id),
        folders: current.folders.map((folder) => ({
          ...folder,
          workflowIds: folder.workflowIds.filter((value) => value !== id),
        })),
        defaultWorkflowId: current.defaultWorkflowId === id ? null : current.defaultWorkflowId,
        avatarWorkflowId: current.avatarWorkflowId === id ? null : current.avatarWorkflowId,
        descriptionWorkflowId:
          current.descriptionWorkflowId === id ? null : current.descriptionWorkflowId,
        shortcuts: current.shortcuts.filter((item) => item.workflowId !== id),
      }));
    },
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
    create: (name) =>
      update((current) => ({
        ...current,
        folders: [
          ...current.folders,
          { id: nextCollectionId(current.folders), name, workflowIds: [] },
        ],
      })),
    rename: (id, name) =>
      update((current) => ({
        ...current,
        folders: current.folders.map((folder) => (folder.id === id ? { ...folder, name } : folder)),
      })),
    remove: (id) =>
      update((current) => ({
        ...current,
        folders: current.folders.filter((folder) => folder.id !== id),
      })),
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
