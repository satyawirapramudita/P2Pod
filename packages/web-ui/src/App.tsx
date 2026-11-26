import React, { useEffect, useState } from 'react';
import { CrtWindowFrame, StatusBanner } from './components/ui/Primitives';
import { useBridgeClient } from './hooks/useBridgeClient';
import { ConsolePage } from './pages/ConsolePage';
import { SetupPage } from './pages/SetupPage';
import { StyleguidePage } from './pages/StyleguidePage';

type RouteView = 'console' | 'styleguide';

function resolveRoute(): RouteView {
  if (
    window.location.pathname === '/styleguide' ||
    window.location.hash === '#/styleguide' ||
    window.location.hash === '#styleguide'
  ) {
    return 'styleguide';
  }
  return 'console';
}

export function App(): React.ReactElement {
  const [route, setRoute] = useState<RouteView>(() => resolveRoute());
  const bridge = useBridgeClient();

  useEffect(() => {
    const onNav = (): void => setRoute(resolveRoute());
    window.addEventListener('popstate', onNav);
    window.addEventListener('hashchange', onNav);
    return () => {
      window.removeEventListener('popstate', onNav);
      window.removeEventListener('hashchange', onNav);
    };
  }, []);

  const navigate = (next: RouteView): void => {
    const targetPath = next === 'styleguide' ? '/styleguide' : '/';
    window.history.pushState({}, '', targetPath);
    setRoute(next);
    window.scrollTo(0, 0);
  };

  if (route === 'styleguide') {
    return <StyleguidePage onNavigateConsole={() => navigate('console')} />;
  }

  if (bridge.loadingInitial && !bridge.state) {
    return (
      <main className="console-shell">
        <CrtWindowFrame title="BOOT // P2POD LOCAL BRIDGE">
          <StatusBanner
            title="Menghubungkan ke Daemon Lokal..."
            description="Membuka saluran WebSocket ke P2Pod WebBridge di 127.0.0.1."
          />
        </CrtWindowFrame>
      </main>
    );
  }

  if (!bridge.state) {
    return <SetupPage bridge={bridge} />;
  }

  return <ConsolePage bridge={bridge} />;
}