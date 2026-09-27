import { lazy, Suspense, useMemo, type ComponentProps } from 'react';
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

/** Chooses the board renderer (3D tabletop or 2D map) from settings. */
export default function GameBoard(props: GameBoardProps) {
  const { settings } = useSettings();
  const canWebgl = useMemo(webglAvailable, []);
  if (settings.boardView === '3d' && canWebgl) {
    return (
      <Suspense fallback={<Board {...props} />}>
        <Board3D {...props} />
      </Suspense>
    );
  }
  return <Board {...props} />;
}
