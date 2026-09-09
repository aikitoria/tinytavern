/* @refresh reload */
import './styles/index.css';
import { render } from 'solid-js/web';
import App from './App.tsx';
import { restoreOpenPage, restorePage } from './media/navigation.ts';
import { installPageNavigation } from './state/pageLocation.ts';
import { configureWs, startWs, stopWs } from './state/ws.ts';
import { handleServerEvent, loadAll, setState } from './state/store.ts';
import { checkAuthentication, configureAuthLifecycle, requireLogin } from './state/auth.ts';
import { setAuthenticationRequiredHandler } from './state/api.ts';
import '@fontsource-variable/ibm-plex-sans';
import '@fontsource-variable/ibm-plex-sans/wght-italic.css';
import 'highlight.js/styles/github-dark.css';

configureWs({
  onEvent: handleServerEvent,
  onOpen: () => void loadAll().then(restoreOpenPage),
  onStatus: (connected) => setState('connected', connected),
  onUnauthorized: () => void checkAuthentication(),
});
configureAuthLifecycle({ onUnlock: startWs, onLock: stopWs });
setAuthenticationRequiredHandler(requireLogin);

installPageNavigation(restorePage);

render(() => <App />, document.getElementById('root')!);
void checkAuthentication();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}
