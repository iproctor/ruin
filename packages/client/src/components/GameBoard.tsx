import type { ComponentProps } from 'react';
import Board from './Board.js';

export type GameBoardProps = ComponentProps<typeof Board>;

/** Chooses the board renderer (2D map or 3D tabletop) from settings. */
export default function GameBoard(props: GameBoardProps) {
  return <Board {...props} />;
}
