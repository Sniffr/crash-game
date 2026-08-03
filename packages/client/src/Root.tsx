import App from './App';
import Lobby from './Lobby';

/**
 * Top-level route switch (no router library — we key off the pathname).
 *   /play*  → the game SPA (<App/>)
 *   /       → the casino lobby (<Lobby/>)
 */
export default function Root() {
  const path = typeof window !== 'undefined' ? window.location.pathname : '/';
  if (path.startsWith('/play')) return <App />;
  return <Lobby />;
}
