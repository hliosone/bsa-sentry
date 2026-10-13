// The Flex, as the centre of the page: in 3D when the browser can, as a flat replica otherwise
// (no WebGL, while the 3D code loads, or if it fails at runtime).
import { Component, lazy, Suspense, type ReactNode } from 'react';
import type { ScreenLines } from './Flex3D.js';

const Flex3D = lazy(() => import('./Flex3D.js'));

const webgl = () => {
  try { return !!document.createElement('canvas').getContext('webgl2'); } catch { return false; }
};

class Fallback extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? this.props.fallback : this.props.children; }
}

export function FlatFlex({ screen }: { screen: ScreenLines }) {
  return (
    <div className="flex-device">
      <div className="flex-screen" data-testid="flex-mirror">
        <img className="crest" src="/bsa-cube-black.png" alt="" />
        <div className="app">{screen.title}</div>
        {screen.lines.map((l) => <div className="tag" key={l}>{l}</div>)}
        <div className="quit">Quit app</div>
      </div>
    </div>
  );
}

export function FlexView({ screen }: { screen: ScreenLines }) {
  if (!webgl()) return <FlatFlex screen={screen} />;
  return (
    <Fallback fallback={<FlatFlex screen={screen} />}>
      <Suspense fallback={<FlatFlex screen={screen} />}><Flex3D screen={screen} /></Suspense>
    </Fallback>
  );
}

export type { ScreenLines };
