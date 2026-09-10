import { ENTITY_FOLDERS, type FolderEntity } from '@tinytavern/shared';
import { state } from '../../state/store.ts';
import { collectionByName } from '../../state/collectionOrder.ts';
import FormField from '../forms/FormFields.tsx';
import type { DefaultField } from '../forms/SettingField.tsx';

export default function EntityFolderField(props: {
  type: FolderEntity;
  field: DefaultField<string>;
  readOnly?: boolean;
}) {
  return (
    <FormField
      label="Folder"
      field={props.field}
      readOnly={props.readOnly}
      options={[
        { value: '', label: 'Root' },
        ...collectionByName(state[ENTITY_FOLDERS[props.type].state]).map((folder) => ({
          value: String(folder.id),
          label: folder.name,
        })),
      ]}
    />
  );
}
