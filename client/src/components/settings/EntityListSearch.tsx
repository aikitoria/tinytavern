export default function EntityListSearch(props: { noun: string; value: string; onChange: (value: string) => void }) {
  return (
    <div class="mb-2 [&_.search-input]:min-h-control">
      <input
        type="search"
        class="search-input w-full min-w-0"
        aria-label={`Search ${props.noun}`}
        placeholder={`Search ${props.noun}…`}
        value={props.value}
        onInput={(event) => props.onChange(event.currentTarget.value)}
      />
    </div>
  );
}
