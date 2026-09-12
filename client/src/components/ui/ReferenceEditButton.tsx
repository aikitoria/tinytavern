import { faArrowUpRightFromSquare } from '@fortawesome/free-solid-svg-icons';
import FontAwesomeIcon from './FontAwesomeIcon.tsx';

export default function ReferenceEditButton(props: { label: string; onClick: () => void; role?: 'menuitem' }) {
  return (
    <button
      type="button"
      class="icon-btn shrink-0"
      title={`Edit ${props.label}`}
      aria-label={`Edit ${props.label}`}
      role={props.role}
      onClick={props.onClick}
    >
      <FontAwesomeIcon icon={faArrowUpRightFromSquare} size={14} />
    </button>
  );
}
