import type { Power, RegionId, FollowerClass } from '@ruin/engine';

export type DragItem =
  | { kind: 'reserve_follower'; followerId: string; followerClass: FollowerClass; power: Power }
  | { kind: 'board_follower';   followerId: string; followerClass: FollowerClass; power: Power; fromRegion: RegionId }
  | { kind: 'hand_card';        cardId: string; power: Power };
