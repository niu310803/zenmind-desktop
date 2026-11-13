import { useEffect, useRef, type DragEvent } from "react";
import type { ArtifactDragIdentity } from "../../shared/contracts/agent-webclient-bridge";
export function useArtifactTabDrag(identity?: ArtifactDragIdentity | null) {
  const state = useRef({ generation: 0, pending: false, token: "", expiresAt: 0 });
  const key = JSON.stringify(identity);
  useEffect(() => { state.current = { generation: state.current.generation + 1, pending: false, token: "", expiresAt: 0 };
    return () => { state.current.generation++; }; }, [key]);
  const prepare = () => {
    if (!identity || state.current.pending) return;
    const current = state.current, generation = current.generation; current.pending = true;
    void window.electronAPI.artifacts.prepareDrag(identity).then(result => {
      if (generation === state.current.generation && result.ok) { current.token = result.token; current.expiresAt = result.expiresAt; }
    }).catch(() => undefined).finally(() => { current.pending = false; });
  };
  return identity ? { draggable: true, onPointerEnter: prepare, onPointerDown: prepare, onFocus: prepare,
    onDragStart(event: DragEvent) {
      event.preventDefault(); event.stopPropagation();
      const current = state.current;
      if (current.token && current.expiresAt > Date.now()) {
        window.electronAPI.artifacts.startDrag(current.token); current.generation++; current.pending = false; current.token = "";
      } else prepare();
    },
  } : {};
}
