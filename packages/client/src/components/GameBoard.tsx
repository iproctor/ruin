import { Component, lazy, Suspense, useMemo, type ComponentProps, type ReactNode } from 'react';
import Board from './Board.js';
import { useSettings } from '../contexts/SettingsContext.js';

export type GameBoardProps = ComponentProps<typeof Board>;

// three.js is large; only load it when the tabletop view is in use.
const Board3D = lazy(() => import('./board3d/Board3D.js'));

function webglAvailable(): boolean {
  try {
    const c = document.createElement('canvas');
    return !!(c.getContext('webgl2') ?? c.getContext('webgl'));
  } catch {
    return false;
  }
}

/** If the 3D tabletop ever throws, keep the game playable on the 2D map. */
class TabletopBoundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(err: unknown) {
    console.error('[board3d] tabletop crashed; falling back to the 2D map', err);
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

/** Chooses the board renderer (3D tabletop or 2D map) from settings. */
export default function GameBoard(props: GameBoardProps) {
  const { settings } = useSettings();
  const canWebgl = useMemo(webglAvailable, []);
  if (settings.boardView === '3d' && canWebgl) {
    const flat = <Board {...props} />;
    return (
      <TabletopBoundary fallback={flat}>
        <Suspense fallback={flat}>
          <Board3D {...props} />
        </Suspense>
      </TabletopBoundary>
    );
  }
  return <Board {...props} />;
}
