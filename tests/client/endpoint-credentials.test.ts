import assert from 'node:assert/strict';
import { mock, test } from 'bun:test';
import { createRoot } from 'solid-js';
import { ENTITY_FIELDS, type Endpoint } from '@tinytavern/shared';

test('endpoint saves preserve API-key removal requested while a submission is pending', async () => {
  const endpoint: Endpoint = {
    ...ENTITY_FIELDS.endpoints,
    id: 1,
    createdAt: 1,
    name: 'Local',
    hasApiKey: true,
    models: [],
  };
  type Field = { value: string | boolean; reset: () => void; changed: () => boolean };
  let fields!: Record<string, Field>;
  let removeKey!: () => void;
  let typeKey!: () => void;
  let finish!: () => void;
  let submitted: Partial<Endpoint> | undefined;
  let editor!: {
    load: (endpoint: Endpoint | undefined, importing?: boolean) => void;
    data: () => Partial<Endpoint>;
    patch: (id: number, data: Partial<Endpoint>) => Promise<Endpoint>;
    create: (data: Partial<Endpoint>) => Promise<Endpoint>;
  };
  const submit = async (data: Partial<Endpoint>) => {
    submitted = { ...data };
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
    return { ...endpoint, ...data, apiKey: '', hasApiKey: data.apiKey !== '' };
  };
  mock.module('../../client/src/state/api.ts', () => ({
    api: {
      endpoints: {
        create: submit,
        patch: (_id: number, data: Partial<Endpoint>) => submit(data),
      },
    },
  }));
  mock.module('../../client/src/state/store.ts', () => ({
    state: { endpoints: [endpoint], settings: { activeEndpointId: 1 } },
  }));
  mock.module('../../client/src/state/settingsSelection.ts', () => ({
    selectSettingsEntity: async () => {},
  }));
  mock.module('../../client/src/util.ts', () => ({
    errorMessage: String,
    createEntityEditor: (options: typeof editor) => {
      editor = options;
      return { selected: () => endpoint, selectedId: () => 1 };
    },
  }));
  mock.module('../../client/src/components/forms/FormFields.tsx', () => ({
    default: () => null,
    createFormFields: (defaults: Record<string, string | boolean>) => {
      fields = Object.fromEntries(
        Object.entries(defaults).map(([key, value]) => [
          key,
          {
            value,
            reset: () => {
              fields[key]!.value = value;
            },
            changed: () => fields[key]!.value !== value,
          },
        ]),
      );
      return {
        fields,
        load: (values: Record<string, string | boolean>) => {
          for (const key in defaults) fields[key]!.value = values[key] ?? defaults[key]!;
        },
        value: () => Object.fromEntries(Object.entries(fields).map(([key, field]) => [key, field.value])),
      };
    },
  }));
  mock.module('../../client/src/components/settings/EntityEditorPane.tsx', () => ({
    default: () => null,
  }));
  mock.module('../../client/src/components/settings/SettingsSection.tsx', () => ({
    default: () => null,
  }));
  // Exercise the real tab controller and its event callbacks without mounting DOM controls.
  mock.module('react/jsx-dev-runtime', () => ({
    Fragment: Symbol('Fragment'),
    jsxDEV: (_type: unknown, props: Record<string, unknown>) => {
      if (props.children === 'API key') removeKey = props.onRevert as () => void;
      if (props.type === 'password') typeKey = props.onInput as () => void;
      return null;
    },
  }));
  const path = '../../client/src/components/settings/tabs/EndpointsTab.tsx';
  const { default: EndpointsTab } = await import(path);
  let dispose!: () => void;
  createRoot((cleanup) => {
    dispose = cleanup;
    EndpointsTab();
  });
  try {
    editor.load(endpoint);
    fields.name!.value = 'Submitted name';
    const saving = editor.patch(endpoint.id, editor.data());
    assert.equal(Object.hasOwn(submitted!, 'apiKey'), false, 'Blank credentials preserve the saved key');
    removeKey();
    assert.equal(editor.data().apiKey, '');
    finish();
    await saving;
    assert.equal(editor.data().apiKey, '', 'An earlier save must not acknowledge the later removal');

    const removal = editor.patch(endpoint.id, editor.data());
    assert.equal(submitted!.apiKey, '', 'The next save must explicitly submit removal');
    fields.apiKey!.value = 'replacement';
    typeKey();
    finish();
    await removal;
    assert.equal(editor.data().apiKey, 'replacement', 'Typing during removal remains a pending edit');
    fields.apiKey!.value = '';
    typeKey();
    assert.equal(Object.hasOwn(editor.data(), 'apiKey'), false, 'Clearing a replacement does not revive removal');

    editor.load(undefined);
    assert.equal(Object.hasOwn(editor.data(), 'apiKey'), false, 'New endpoints can omit an empty key');
    const creating = editor.create(editor.data());
    removeKey();
    finish();
    await creating;
    assert.equal(editor.data().apiKey, '', 'Creation must preserve later removal intent too');
    editor.load({ ...endpoint, hasApiKey: false });
    assert.equal(Object.hasOwn(editor.data(), 'apiKey'), false, 'Loading accepted state clears acknowledged removal');
  } finally {
    dispose();
  }
});
