/* @refresh reload */
import './styles/index.css';
import { render } from 'solid-js/web';
import App from './App.tsx';
import { restoreOpenPage, restorePage } from './media/navigation.ts';
import { installPageNavigation } from './state/pageLocation.ts';
import { currentBackAction } from './state/uiBack.ts';
import { configureWs, startWs, stopWs } from './state/ws.ts';
import { handleServerEvent, loadAll, setState } from './state/store.ts';
import { checkAuthentication, configureAuthLifecycle, requireLogin } from './state/auth.ts';
import { setAuthenticationRequiredHandler } from './state/api.ts';
import '@fontsource-variable/ibm-plex-sans';
import '@fontsource-variable/ibm-plex-sans/wght-italic.css';
import 'highlight.js/styles/github-dark.css';
import { pwaStartUrl } from './pwa.ts';

// Keep existing bookmarks and hash routes while putting the page inside its app scope.
const startUrl = pwaStartUrl(import.meta.env.DEV);
if (location.pathname !== startUrl) {
  history.replaceState(history.state, '', startUrl + location.search + location.hash);
}

configureWs({
  onEvent: handleServerEvent,
  onOpen: () => void loadAll().then(restoreOpenPage),
  onStatus: (connected) => setState('connected', connected),
  onUnauthorized: () => void checkAuthentication(),
});
configureAuthLifecycle({ onUnlock: startWs, onLock: stopWs });
setAuthenticationRequiredHandler(requireLogin);

installPageNavigation(restorePage, currentBackAction);

render(() => <App />, document.getElementById('root')!);
void checkAuthentication();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}
