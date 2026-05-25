import { type CSSProperties, type RefObject, useSyncExternalStore } from 'react';
import LiquidGlass from 'liquid-glass-react';

type LiquidGlassMode = 'standard' | 'polar' | 'prominent' | 'shader';

type LiquidGlassBackdropProps = {
  aberrationIntensity?: number;
  blurAmount?: number;
  className?: string;
  cornerRadius: number;
  displacementScale?: number;
  elasticity?: number;
  mode?: LiquidGlassMode;
  mouseContainer?: RefObject<HTMLElement | null>;
  overLight?: boolean;
  resizeKey?: number | string;
  saturation?: number;
  staticEffect?: boolean;
};

const staticGlassMousePosition = { x: 0, y: 0 };
const visualEffectsChangedEvent = 'current:visual-effects-changed';

const liquidGlassLayerStyle: CSSProperties = {
  position: 'absolute',
  top: '50%',
  left: '50%',
  width: '100%',
  height: '100%',
};

function readFastGraphicsSnapshot(): boolean {
  if (typeof document === 'undefined') {
    return false;
  }
  return (
    document.documentElement.dataset.fastGraphicsMode === 'true' ||
    document.body?.dataset.fastGraphicsMode === 'true'
  );
}

function subscribeVisualEffects(callback: () => void): () => void {
  if (typeof window === 'undefined') {
    return () => undefined;
  }
  window.addEventListener(visualEffectsChangedEvent, callback);
  return () => window.removeEventListener(visualEffectsChangedEvent, callback);
}

export function notifyVisualEffectsChanged() {
  window.dispatchEvent(new Event(visualEffectsChangedEvent));
}

export function LiquidGlassBackdrop({
  aberrationIntensity = 2,
  blurAmount = 0.06,
  className = '',
  cornerRadius,
  displacementScale = 44,
  elasticity = 0.16,
  mode = 'standard',
  mouseContainer,
  overLight = false,
  resizeKey,
  saturation = 145,
  staticEffect = false,
}: LiquidGlassBackdropProps) {
  const fastGraphicsMode = useSyncExternalStore(
    subscribeVisualEffects,
    readFastGraphicsSnapshot,
    () => false,
  );
  if (fastGraphicsMode) {
    return (
      <span
        className={`liquid-glass-backdrop liquid-glass-backdrop-static ${className} ${overLight ? 'over-light' : ''}`}
        aria-hidden="true"
      >
        <span className="liquid-glass-fill" />
      </span>
    );
  }

  return (
    <span className={`liquid-glass-backdrop ${className} ${overLight ? 'over-light' : ''}`} aria-hidden="true">
      <LiquidGlass
        key={resizeKey}
        className="liquid-glass-layer"
        style={liquidGlassLayerStyle}
        padding="0"
        cornerRadius={cornerRadius}
        displacementScale={displacementScale}
        blurAmount={blurAmount}
        saturation={saturation}
        aberrationIntensity={aberrationIntensity}
        elasticity={elasticity}
        mode={mode}
        globalMousePos={staticEffect ? staticGlassMousePosition : undefined}
        mouseOffset={staticEffect ? staticGlassMousePosition : undefined}
        mouseContainer={staticEffect ? undefined : mouseContainer}
        overLight={overLight}
      >
        <span className="liquid-glass-fill" />
      </LiquidGlass>
    </span>
  );
}
