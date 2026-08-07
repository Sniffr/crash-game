import App from './App';
import Lobby from './Lobby';
import Simulate from './Simulate';

/**
 * Top-level route switch (no router library — we key off the pathname).
 *   /play*      → the crash game SPA (<App/>)
 *   /simulate*  → the Simulate sports game (<Simulate/>)
 *   /           → the casino lobby (<Lobby/>)
 */
export default function Root() {
  const path = typeof window !== 'undefined' ? window.location.pathname : '/';
  if (path.startsWith('/play')) return <App />;
  if (path.startsWith('/simulate')) return <Simulate />;
  return <Lobby />;
}
