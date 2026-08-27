export default function GallerySelectIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      stroke-width="1.8"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <rect x="3" y="3" width="6" height="6" rx="1.5" />
      <path d="m4.7 6 1.1 1.1L7.7 5" />
      <path d="M12 6h9" />
      <rect x="3" y="15" width="6" height="6" rx="1.5" />
      <path d="M12 18h9" />
    </svg>
  );
}

export function GallerySelectAllIcon(props: { checked: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      stroke-width="1.8"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M6 17H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v1" />
      <rect x="7" y="7" width="14" height="14" rx="2" />
      {props.checked ? <path d="m10.5 14 2.2 2.2 4.8-5" /> : null}
    </svg>
  );
}
