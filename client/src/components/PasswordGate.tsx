import { Show, createSignal } from 'solid-js';
import { authCheckError, checkAuthentication, login } from '../state/auth.ts';
import { errorMessage } from '../util.ts';

export default function PasswordGate() {
  const [password, setPassword] = createSignal('');
  const [error, setError] = createSignal('');
  const [submitting, setSubmitting] = createSignal(false);

  const submit = async (event: SubmitEvent) => {
    event.preventDefault();
    if (submitting()) return;
    setSubmitting(true);
    setError('');
    try {
      await login(password());
      setPassword('');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main class="password-gate">
      <form class="password-card" onSubmit={(event) => void submit(event)}>
        <img src="/icon.svg" alt="" width="64" height="64" />
        <h1>TinyTavern</h1>
        <p>Enter the access password to continue.</p>
        <label for="access-password">Password</label>
        <input
          id="access-password"
          type="password"
          autocomplete="current-password"
          autofocus
          value={password()}
          onInput={(event) => setPassword(event.currentTarget.value)}
        />
        <button class="primary-btn" type="submit" disabled={submitting() || password() === ''}>
          {submitting() ? 'Signing in…' : 'Sign in'}
        </button>
        <Show when={error() || authCheckError()}>
          <p class="password-error">{error() || authCheckError()}</p>
        </Show>
        <Show when={authCheckError()}>
          <button type="button" onClick={() => void checkAuthentication()}>
            Retry connection
          </button>
        </Show>
      </form>
    </main>
  );
}
