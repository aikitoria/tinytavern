export default function GalleryIcon(props: { filled?: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill={props.filled ? 'currentColor' : 'none'}
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <rect x="3" y="5" width="16" height="14" rx="2" />
      <path d="M7 5V3h14v14h-2" />
      <circle cx="8.5" cy="10" r="1.5" fill={props.filled ? 'var(--bg-panel)' : 'none'} />
      <path d="m5 17 4-4 3 3 2-2 3 3" />
    </svg>
  );
}
