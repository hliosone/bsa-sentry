// The Flex in 3D, its E Ink screen drawn live from the device state. The one bold element of
// the console: the device is the authority, so it sits at the centre. Loaded lazily; the flat
// replica stands in when WebGL is missing, and the motion stops for prefers-reduced-motion.
import { useEffect, useMemo, useRef } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { ContactShadows, OrbitControls, RoundedBox } from '@react-three/drei';
import * as THREE from 'three';

export type ScreenLines = { title: string; lines: string[] };

const W = 480;
const H = 600; // the Flex screen is 480 x 600

/** Paints the home screen the way the device draws it: E Ink paper, black Inter, a Quit bar. */
function paint(ctx: CanvasRenderingContext2D, s: ScreenLines) {
  ctx.fillStyle = '#f4f4ef';
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#000';
  ctx.strokeStyle = '#000';
  // The app's crest: a shield in a circle.
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.arc(W / 2, 150, 34, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(W / 2, 128); ctx.lineTo(W / 2 - 16, 135); ctx.lineTo(W / 2 - 16, 152);
  ctx.quadraticCurveTo(W / 2 - 14, 168, W / 2, 174); ctx.quadraticCurveTo(W / 2 + 14, 168, W / 2 + 16, 152);
  ctx.lineTo(W / 2 + 16, 135); ctx.closePath(); ctx.lineWidth = 3; ctx.stroke();
  ctx.textAlign = 'center';
  ctx.font = '600 38px Inter, system-ui, sans-serif';
  ctx.fillText(s.title, W / 2, 250);
  ctx.font = '400 26px Inter, system-ui, sans-serif';
  s.lines.forEach((l, i) => ctx.fillText(l, W / 2, 305 + i * 38));
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(0, H - 86); ctx.lineTo(W, H - 86); ctx.stroke();
  ctx.font = '600 24px Inter, system-ui, sans-serif';
  ctx.fillText('Quit app', W / 2, H - 36);
}

function Device({ screen, still }: { screen: ScreenLines; still: boolean }) {
  const group = useRef<THREE.Group>(null);
  const canvas = useMemo(() => Object.assign(document.createElement('canvas'), { width: W, height: H }), []);
  const texture = useMemo(() => {
    const t = new THREE.CanvasTexture(canvas);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 8;
    return t;
  }, [canvas]);

  useEffect(() => {
    const draw = () => { paint(canvas.getContext('2d')!, screen); texture.needsUpdate = true; };
    draw();
    // Inter may still be loading on first paint: redraw once the fonts are in.
    void document.fonts?.ready.then(draw);
  }, [canvas, texture, screen]);

  useFrame(({ clock }) => {
    if (!group.current || still) return;
    const t = clock.getElapsedTime();
    group.current.rotation.y = Math.sin(t * 0.35) * 0.28;
    group.current.rotation.x = -0.06 + Math.sin(t * 0.27) * 0.03;
  });

  return (
    <group ref={group} rotation={[-0.06, -0.2, 0]}>
      {/* The body: matte black, softly rounded. */}
      <RoundedBox args={[2.72, 3.42, 0.3]} radius={0.24} smoothness={8}>
        <meshStandardMaterial color="#141414" roughness={0.38} metalness={0.35} />
      </RoundedBox>
      {/* The E Ink screen, unlit so it reads like paper. */}
      <mesh position={[0, 0.08, 0.152]}>
        <planeGeometry args={[2.24, 2.8]} />
        <meshBasicMaterial map={texture} toneMapped={false} />
      </mesh>
      {/* The side button. */}
      <RoundedBox args={[0.05, 0.42, 0.12]} radius={0.02} position={[1.385, 0.7, 0]}>
        <meshStandardMaterial color="#1a1a1a" roughness={0.3} metalness={0.5} />
      </RoundedBox>
    </group>
  );
}

export default function Flex3D({ screen }: { screen: ScreenLines }) {
  const still = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  return (
    <Canvas camera={{ position: [0, 0, 7.1], fov: 38 }} dpr={[1, 2]} gl={{ antialias: true, alpha: true }} aria-label="Your Flex, showing its home screen">
      <ambientLight intensity={0.55} />
      <directionalLight position={[3, 4, 5]} intensity={1.4} />
      <directionalLight position={[-4, -2, 2]} intensity={0.5} color="#cfd6ff" />
      {/* Rim light from behind, so the black body separates from the stage. */}
      <directionalLight position={[0, 2, -5]} intensity={2.2} />
      <pointLight position={[-3, 3, -2]} intensity={6} distance={9} />
      <Device screen={screen} still={!!still} />
      <ContactShadows position={[0, -1.95, 0]} opacity={0.5} scale={6} blur={2.6} far={3} color="#000" />
      <OrbitControls enableZoom={false} enablePan={false} minPolarAngle={Math.PI / 2 - 0.35} maxPolarAngle={Math.PI / 2 + 0.25} minAzimuthAngle={-0.8} maxAzimuthAngle={0.8} />
    </Canvas>
  );
}
