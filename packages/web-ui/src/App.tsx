import React, { useEffect, useState } from 'react';
import { useBridgeClient } from './hooks/useBridgeClient';
import { ConsolePage } from './pages/ConsolePage';
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

  return <ConsolePage bridge={bridge} onNavigateStyleguide={() => navigate('styleguide')} />;
}
