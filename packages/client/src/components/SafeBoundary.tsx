import { Component, type ReactNode } from 'react';

/**
 * Presentation-only subtrees (cinematics, effects) must never take the game
 * down with them. On error this renders `fallback` (default: nothing) and
 * retries when `resetKey` changes.
 */
export default class SafeBoundary extends Component<
  { children: ReactNode; fallback?: ReactNode; label: string; resetKey?: unknown },
  { failed: boolean; key: unknown }
> {
  state = { failed: false, key: this.props.resetKey };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  static getDerivedStateFromProps(props: { resetKey?: unknown }, state: { failed: boolean; key: unknown }) {
    if (props.resetKey !== state.key) return { failed: false, key: props.resetKey };
    return null;
  }
  componentDidCatch(err: unknown) {
    console.error(`[${this.props.label}] render failed; hidden`, err);
  }
  render() {
    return this.state.failed ? (this.props.fallback ?? null) : this.props.children;
  }
}
